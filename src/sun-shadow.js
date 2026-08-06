import * as THREE from 'three';

// ---- SUN SHADOWS ----
// Replaces three's CSM addon, which produced a hard shadow/no-shadow edge that
// swung across the terrain whenever the plane rolled or pitched. Three failures
// in that addon combined to make it:
//
//   1. Each cascade's light is parked at `bbox.max.z + lightMargin` in light
//      space with a FIXED shadow-camera depth range (lightNear..lightFar). The
//      outermost cascade of a 60-degree/14000-unit frustum is ~33000 units deep
//      along the sun axis, so a 25000-unit range cut it off partway. Everything
//      past the cut has shadowCoord.z > 1, which three's getShadow() reports as
//      fully lit - a hard line, oriented perpendicular to the SUN rather than to
//      the camera, which is why it read as a line running out ahead of the plane
//      with shadow on one side and none on the other.
//   2. The clipped region is derived from the axis-aligned bounds of the ROTATED
//      camera frustum in light space, so the line jumps as soon as the camera
//      turns. Hence "moves drastically when I roll or pitch".
//   3. Casters more than lightMargin above the fitted box are never rasterised
//      into the map at all, so a plane climbing away from the terrain silently
//      drops its own shadow.
//
// The system below is built so none of those can happen:
//
//   * Cascades are NESTED - cascade i is fitted to the whole frustum from the
//     near plane out to split i, not to the slab between split i-1 and i. The
//     shader then picks a cascade by RADIAL distance, and radius >= planar depth,
//     so a fragment assigned to cascade i is always inside the region cascade i
//     was fitted to. There is no orientation for which selection and coverage can
//     disagree, which is the actual invariant the old code lacked.
//   * Each cascade is fitted to the BOUNDING SPHERE of its frustum. A sphere's
//     radius depends only on fov/aspect/near/far, never on where the camera is
//     pointing, so the ortho box is a fixed size and the fit cannot degrade with
//     roll or pitch. Its centre is snapped to the shadow map's texel grid so the
//     shadow edges do not crawl as the plane moves.
//   * The shadow camera's depth range is derived from that same radius plus a
//     caster headroom, every frame, per cascade. Nothing can fall outside it.
//   * Cascade transitions and the outer edge of the shadowed region are weighted
//     cross-fades, so the worst a boundary can ever look is a soft gradient. Any
//     weight no cascade claims stays lit, which is what dissolves the far edge.
const _stockLightsFragmentBegin = THREE.ShaderChunk.lights_fragment_begin;
const _stockLightsParsBegin = THREE.ShaderChunk.lights_pars_begin;

// The point/spot/rect-area/indirect sections are three 0.160's stock
// lights_fragment_begin verbatim; only the directional block is ours.
const SUN_SHADOW_FRAGMENT_BEGIN = /* glsl */`
vec3 geometryPosition = - vViewPosition;
vec3 geometryNormal = normal;
vec3 geometryViewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : normalize( vViewPosition );

vec3 geometryClearcoatNormal = vec3( 0.0 );

#ifdef USE_CLEARCOAT

	geometryClearcoatNormal = clearcoatNormal;

#endif

#ifdef USE_IRIDESCENCE
	float dotNVi = saturate( dot( normal, geometryViewDir ) );
	if ( material.iridescenceThickness == 0.0 ) {
		material.iridescence = 0.0;
	} else {
		material.iridescence = saturate( material.iridescence );
	}
	if ( material.iridescence > 0.0 ) {
		material.iridescenceFresnel = evalIridescence( 1.0, material.iridescenceIOR, dotNVi, material.iridescenceThickness, material.specularColor );
		material.iridescenceF0 = Schlick_to_F0( material.iridescenceFresnel, 1.0, dotNVi );
	}
#endif

IncidentLight directLight;

#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )

	PointLight pointLight;
	#if defined( USE_SHADOWMAP ) && NUM_POINT_LIGHT_SHADOWS > 0
	PointLightShadow pointLightShadow;
	#endif

	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {

		pointLight = pointLights[ i ];

		getPointLightInfo( pointLight, geometryPosition, directLight );

		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_POINT_LIGHT_SHADOWS )
		pointLightShadow = pointLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getPointShadow( pointShadowMap[ i ], pointLightShadow.shadowMapSize, pointLightShadow.shadowBias, pointLightShadow.shadowRadius, vPointShadowCoord[ i ], pointLightShadow.shadowCameraNear, pointLightShadow.shadowCameraFar ) : 1.0;
		#endif

		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

	}
	#pragma unroll_loop_end

#endif

#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )

	SpotLight spotLight;
	vec4 spotColor;
	vec3 spotLightCoord;
	bool inSpotLightMap;

	#if defined( USE_SHADOWMAP ) && NUM_SPOT_LIGHT_SHADOWS > 0
	SpotLightShadow spotLightShadow;
	#endif

	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {

		spotLight = spotLights[ i ];

		getSpotLightInfo( spotLight, geometryPosition, directLight );

		#if ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#define SPOT_LIGHT_MAP_INDEX UNROLLED_LOOP_INDEX
		#elif ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		#define SPOT_LIGHT_MAP_INDEX NUM_SPOT_LIGHT_MAPS
		#else
		#define SPOT_LIGHT_MAP_INDEX ( UNROLLED_LOOP_INDEX - NUM_SPOT_LIGHT_SHADOWS + NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS )
		#endif
		#if ( SPOT_LIGHT_MAP_INDEX < NUM_SPOT_LIGHT_MAPS )
			spotLightCoord = vSpotLightCoord[ i ].xyz / vSpotLightCoord[ i ].w;
			inSpotLightMap = all( lessThan( abs( spotLightCoord * 2. - 1. ), vec3( 1.0 ) ) );
			spotColor = texture2D( spotLightMap[ SPOT_LIGHT_MAP_INDEX ], spotLightCoord.xy );
			directLight.color = inSpotLightMap ? directLight.color * spotColor.rgb : directLight.color;
		#endif
		#undef SPOT_LIGHT_MAP_INDEX

		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS )
		spotLightShadow = spotLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;
		#endif

		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

	}
	#pragma unroll_loop_end

#endif

#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct ) && defined( USE_CSM ) && defined( CSM_CASCADES )

	// Every directional light in a USE_CSM material is a cascade of the same sun, so
	// exactly one RE_Direct call is made and directionalLights[ 0 ] carries the colour.
	DirectionalLight directionalLight;

	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0

		DirectionalLightShadow directionalLightShadow;

		// Radial, not planar: csmSplits[ i ].y is the radius out to which cascade i was
		// fitted, and length( vViewPosition ) is the fragment's radius. Because the
		// cascades are nested, "radius < limit" is by itself proof the fragment is
		// inside cascade i's shadow map, for any camera orientation.
		float csmRadius = length( vViewPosition );

		// csmRemain is the share of this fragment no nearer cascade has claimed yet, so
		// the nearest (sharpest) cascade that covers the fragment always wins and the
		// weights sum to exactly 1 without a second pass.
		float csmRemain = 1.0;
		float csmShadow = 0.0;

		// Declared out here on purpose: three unrolls the loop below by pasting the body
		// N times into this same scope, so anything declared inside would redeclare.
		float csmAvail;
		float csmWeight;

		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {

			csmAvail = 1.0 - smoothstep( csmSplits[ i ].x, csmSplits[ i ].y, csmRadius );
			csmWeight = csmAvail * csmRemain;

			if ( csmWeight > 0.0 ) {

				directionalLightShadow = directionalLightShadows[ i ];
				csmShadow += csmWeight * getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] );

			}

			csmRemain *= ( 1.0 - csmAvail );

		}
		#pragma unroll_loop_end

		// Past the last cascade nothing is claimed, so csmRemain rises to 1 and the
		// fragment ends up fully lit - the far edge of the shadowed region dissolves
		// over the last cascade's fade band instead of ending on a line.
		csmShadow += csmRemain;

		directionalLight = directionalLights[ 0 ];
		getDirectionalLightInfo( directionalLight, directLight );
		directLight.color *= ( directLight.visible && receiveShadow ) ? csmShadow : 1.0;
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

	#else

		directionalLight = directionalLights[ 0 ];
		getDirectionalLightInfo( directionalLight, directLight );
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

	#endif

#endif

#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct ) && !defined( USE_CSM ) && !defined( CSM_CASCADES )

	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif

	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {

		directionalLight = directionalLights[ i ];

		getDirectionalLightInfo( directionalLight, directLight );

		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif

		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

	}
	#pragma unroll_loop_end

#endif

#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )

	RectAreaLight rectAreaLight;

	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_RECT_AREA_LIGHTS; i ++ ) {

		rectAreaLight = rectAreaLights[ i ];
		RE_Direct_RectArea( rectAreaLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

	}
	#pragma unroll_loop_end

#endif

#if defined( RE_IndirectDiffuse )

	vec3 iblIrradiance = vec3( 0.0 );

	vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );

	#if defined( USE_LIGHT_PROBES )

		irradiance += getLightProbeIrradiance( lightProbe, geometryNormal );

	#endif

	#if ( NUM_HEMI_LIGHTS > 0 )

		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {

			irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );

		}
		#pragma unroll_loop_end

	#endif

#endif

#if defined( RE_IndirectSpecular )

	vec3 radiance = vec3( 0.0 );
	vec3 clearcoatRadiance = vec3( 0.0 );

#endif
`;

const SUN_SHADOW_PARS_BEGIN = /* glsl */`
#if defined( USE_CSM ) && defined( CSM_CASCADES )
uniform vec2 csmSplits[ CSM_CASCADES ];
#endif
` + _stockLightsParsBegin;

const _ssLightBasis = new THREE.Matrix4();
const _ssLightBasisInv = new THREE.Matrix4();
const _ssCenter = new THREE.Vector3();
const _ssForward = new THREE.Vector3();
const _ssCamPos = new THREE.Vector3();
const _ssOrigin = new THREE.Vector3();

class SunShadow {

    constructor(data) {
        this.camera = data.camera;
        this.parent = data.parent;
        this.cascades = data.cascades || 3;
        this.maxFar = data.maxFar || 20000;
        this.shadowMapSize = data.shadowMapSize || 1024;
        this.lightDirection = new THREE.Vector3().copy(data.lightDirection).normalize();
        this.lightIntensity = data.lightIntensity !== undefined ? data.lightIntensity : 3;
        this.lightColor = data.lightColor !== undefined ? data.lightColor : new THREE.Color(0xffffff);

        // How far above a cascade's sphere a caster can still be and be drawn
        // into that cascade's map. This is the one number that decides whether a
        // high-flying plane keeps its shadow on the ground, so it is sized to the
        // whole playable altitude band rather than tuned by eye.
        this.casterHeadroom = data.casterHeadroom !== undefined ? data.casterHeadroom : 8000;

        // Width of the cross-fade at the outer edge of each cascade, as a
        // fraction of that cascade's radius. Cascade i+1 must fully cover the
        // band cascade i fades out over; validateSplits() below asserts that.
        this.blendFraction = data.blendFraction !== undefined ? data.blendFraction : 0.12;

        // Depth bias, in multiples of a cascade's world-space texel size. Bias
        // has to scale with the cascade because the outer cascades have texels
        // tens of units across; a single constant either acnes the near cascade
        // or peter-pans the far one.
        this.biasTexels = data.biasTexels !== undefined ? data.biasTexels : 1.5;
        this.normalBiasTexels = data.normalBiasTexels !== undefined ? data.normalBiasTexels : 1.0;

        // Per cascade: radial limit, sphere radius, distance from the camera to
        // the sphere centre along the view axis, and the light's standoff.
        this.limits = [];
        this.radii = [];
        this.centerDist = [];
        this.standoff = [];

        // Shared by every material's uniform block, so writing through it here
        // updates all of them at once.
        this.splitUniform = [];

        this.lights = [];
        this.shaders = new Map();

        // Snapping has to happen on the same axes the shadow camera ends up
        // using, and three builds those with Object3D.lookAt against the
        // camera's `up`. Match it, and fall back to +Z if the sun is ever moved
        // close enough to vertical that (0,1,0) degenerates.
        this.up = Math.abs(this.lightDirection.y) > 0.999
            ? new THREE.Vector3(0, 0, 1)
            : new THREE.Vector3(0, 1, 0);

        this.createLights();
        this.updateFrustums();
        this.injectInclude();
    }

    createLights() {
        for (let i = 0; i < this.cascades; i++) {
            const light = new THREE.DirectionalLight(this.lightColor, this.lightIntensity);
            light.castShadow = true;
            light.shadow.mapSize.width = this.shadowMapSize;
            light.shadow.mapSize.height = this.shadowMapSize;
            light.shadow.camera.up.copy(this.up);
            light.up.copy(this.up);
            this.parent.add(light);
            this.parent.add(light.target);
            this.lights.push(light);
            this.splitUniform.push(new THREE.Vector2());
        }
    }

    // Practical split scheme (half uniform, half logarithmic) over RADIAL
    // distance. These are the limits the shader compares against, and the same
    // numbers the spheres are fitted to, so the two can never drift apart.
    computeSplits() {
        const camera = this.camera;
        const near = camera.near;
        const far = Math.min(camera.far, this.maxFar);

        this.limits.length = 0;
        for (let i = 1; i <= this.cascades; i++) {
            const p = i / this.cascades;
            const uniform = near + (far - near) * p;
            const logarithmic = near * Math.pow(far / near, p);
            this.limits.push(THREE.MathUtils.lerp(uniform, logarithmic, 0.5));
        }
        this.limits[this.cascades - 1] = far;
    }

    // Bounding sphere of the frustum from the near plane out to `limit`. The
    // frustum is the convex hull of its apex and its four far corners, and a
    // sphere is convex, so a sphere through those five points contains all of
    // it. Only fov, aspect and near enter the result - nothing about where the
    // camera points - which is the property the old fit was missing.
    updateShadowBounds() {
        const camera = this.camera;
        const near = camera.near;
        const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
        const tanX = tanY * camera.aspect;
        const kSq = tanX * tanX + tanY * tanY;

        this.radii.length = 0;
        this.centerDist.length = 0;
        this.standoff.length = 0;

        for (let i = 0; i < this.cascades; i++) {
            const limit = this.limits[i];

            // Solve |apex - c| == |farCorner - c| with c on the view axis.
            const centerDist = (limit * limit * (kSq + 1.0) - near * near) / (2.0 * (limit - near));
            const radius = centerDist - near;

            this.radii.push(radius);
            this.centerDist.push(centerDist);
            this.standoff.push(radius + this.casterHeadroom);

            const light = this.lights[i];
            const shadowCam = light.shadow.camera;
            shadowCam.left = -radius;
            shadowCam.right = radius;
            shadowCam.top = radius;
            shadowCam.bottom = -radius;

            // The light sits `standoff` back along the sun axis, so the far side
            // of the sphere is standoff + radius away. Anything between the sun
            // and the sphere is inside this range by construction, which is what
            // makes the clipped-shadow line impossible.
            shadowCam.near = 1;
            shadowCam.far = this.standoff[i] + radius;
            shadowCam.updateProjectionMatrix();

            const texelWorld = (2.0 * radius) / this.shadowMapSize;
            const depthRange = shadowCam.far - shadowCam.near;
            light.shadow.bias = -(this.biasTexels * texelWorld) / depthRange;
            light.shadow.normalBias = this.normalBiasTexels * texelWorld;

            this.splitUniform[i].set(limit * (1.0 - this.blendFraction), limit);
        }
    }

    // Cascade i fades out over [limit_i * (1 - blend), limit_i]. Cascade i+1 has
    // to be at full strength across that whole band or the cross-fade uncovers a
    // gap, which would show up as exactly the kind of seam this rewrite exists to
    // remove. Warn loudly rather than ship a silent one.
    validateSplits() {
        for (let i = 0; i < this.cascades - 1; i++) {
            const fadeStart = this.limits[i] * (1.0 - this.blendFraction);
            const nextFull = this.limits[i + 1] * (1.0 - this.blendFraction);
            if (fadeStart >= nextFull) {
                console.warn(
                    `SunShadow: cascade ${i} fades out at ${fadeStart.toFixed(0)} but cascade ` +
                    `${i + 1} is only at full strength below ${nextFull.toFixed(0)}. Lower ` +
                    `blendFraction or add a cascade.`
                );
            }
        }
    }

    update() {
        const camera = this.camera;

        _ssLightBasis.lookAt(_ssOrigin, this.lightDirection, this.up);
        _ssLightBasisInv.copy(_ssLightBasis).transpose();

        const e = camera.matrixWorld.elements;
        _ssCamPos.set(e[12], e[13], e[14]);
        _ssForward.set(-e[8], -e[9], -e[10]).normalize();

        for (let i = 0; i < this.cascades; i++) {
            const light = this.lights[i];
            const radius = this.radii[i];
            const texel = (2.0 * radius) / this.shadowMapSize;

            _ssCenter.copy(_ssForward).multiplyScalar(this.centerDist[i]).add(_ssCamPos);

            // Quantise the centre on the shadow map's own axes. Without this the
            // sphere slides by sub-texel amounts every frame and every shadow
            // edge in the scene crawls.
            _ssCenter.applyMatrix4(_ssLightBasisInv);
            _ssCenter.x = Math.floor(_ssCenter.x / texel) * texel;
            _ssCenter.y = Math.floor(_ssCenter.y / texel) * texel;
            _ssCenter.applyMatrix4(_ssLightBasis);

            light.target.position.copy(_ssCenter);
            light.position.copy(this.lightDirection).multiplyScalar(-this.standoff[i]).add(_ssCenter);
        }
    }

    injectInclude() {
        THREE.ShaderChunk.lights_fragment_begin = SUN_SHADOW_FRAGMENT_BEGIN;
        THREE.ShaderChunk.lights_pars_begin = SUN_SHADOW_PARS_BEGIN;
    }

    setupMaterial(material) {
        material.defines = material.defines || {};
        material.defines.USE_CSM = 1;
        material.defines.CSM_CASCADES = this.cascades;

        const shaders = this.shaders;
        const splitUniform = this.splitUniform;

        material.onBeforeCompile = function (shader) {
            shader.uniforms.csmSplits = { value: splitUniform };
            shaders.set(material, shader);
        };

        shaders.set(material, null);
    }

    // Every material shares the one splitUniform array by reference, so the
    // values are already current; this only exists to re-point shaders compiled
    // before a resize at that array.
    updateUniforms() {
        const splitUniform = this.splitUniform;
        this.shaders.forEach(function (shader) {
            if (shader !== null) shader.uniforms.csmSplits.value = splitUniform;
        });
    }

    updateFrustums() {
        this.camera.updateProjectionMatrix();
        this.computeSplits();
        this.updateShadowBounds();
        this.validateSplits();
        this.updateUniforms();
    }

    remove() {
        for (let i = 0; i < this.lights.length; i++) {
            this.parent.remove(this.lights[i].target);
            this.parent.remove(this.lights[i]);
        }
    }

    dispose() {
        this.shaders.forEach(function (shader, material) {
            delete material.onBeforeCompile;
            delete material.defines.USE_CSM;
            delete material.defines.CSM_CASCADES;
            if (shader !== null) delete shader.uniforms.csmSplits;
            material.needsUpdate = true;
        });
        this.shaders.clear();

        THREE.ShaderChunk.lights_fragment_begin = _stockLightsFragmentBegin;
        THREE.ShaderChunk.lights_pars_begin = _stockLightsParsBegin;
    }

}

export { SunShadow };
