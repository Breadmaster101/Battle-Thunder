import * as THREE from 'three';
import { CONFIG, MAX_PROJECTILES, TREE_GRID_SIZE, WORLD_CHUNK_DIM, SUN_DIR } from './config.js';
import { G, players, waterMeshes, cloudsData, treeGridArr } from './state.js';
import { _tempVec, _cineDummyCam, _cineStartOffset, _cineLocalLookAt } from './scratch.js';
import { yieldToBrowser } from './utils.js';
import { SunShadow } from './sun-shadow.js';
import { getUIPlane, stopUI3D } from './ui-3d.js';
import { warmUpAudioPipelines } from './audio.js';
import { buildTerrainGrid, getTerrainHeight, hashCode, setMapSeed, getMapSeed } from './terrain.js';
import { buildChunkedTerrain, freezeTransform, attachPooled, detachPooled } from './geometry-utils.js';
import { createPineTreeMesh, createDeciduousTreeMesh, createRockMesh, createCloudMesh } from './scenery.js';
import { claimMuzzleLight } from './muzzle-light.js';
import { ParticlePool, sharedExplosionGeo } from './particles.js';
import { Projectile, projectilePool } from './projectile.js';
import { Player } from './player.js';
import { createRenderer } from './renderer.js';
import { initBloom, renderBloom } from './bloom.js';
import { handleKey } from './input.js';
import { cacheDOM } from './hud.js';
import { animate } from './loop.js';
import { TERRAIN_WORKER_SOURCE } from './terrain-worker-source.js';

// Compile alone does not create every GPU render target or guarantee that
// drivers finish linking programs. Render two frames while the deployment
// overlay is still visible so this one-time work cannot interrupt gameplay.
async function warmUpRenderer(me) {
    me.mesh.updateMatrixWorld();

    // Compile from the same camera region used by the opening cinematic so
    // frustum-dependent materials are included in the warm-up pass.
    _cineDummyCam.position.set(-10, 7, -8);
    _cineDummyCam.lookAt(0, 0, 0);
    _cineDummyCam.translateX(-2.4);
    _cineStartOffset.copy(_cineDummyCam.position).applyMatrix4(me.mesh.matrixWorld);
    me.camera.position.copy(_cineStartOffset);
    _tempVec.set(0, 0, -10).applyQuaternion(_cineDummyCam.quaternion);
    _cineLocalLookAt.copy(_cineDummyCam.position).add(_tempVec).applyMatrix4(me.mesh.matrixWorld);
    me.camera.lookAt(_cineLocalLookAt);
    me.camera.fov = 45;
    me.camera.updateProjectionMatrix();
    me.camera.updateMatrixWorld();

    if (G.csm) {
        G.csm.updateFrustums();
        G.csm.update();
    }
    if (G.renderer.compileAsync) {
        await G.renderer.compileAsync(G.scene, me.camera);
    } else {
        G.renderer.compile(G.scene, me.camera);
    }

    G.renderer.render(G.scene, me.camera);
    renderBloom(me.camera);
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (G.csm) G.csm.update();
    G.renderer.render(G.scene, me.camera);
    renderBloom(me.camera);
}

async function initGameWorld(playerList, roomCode) {
    console.group("Initializing Game");
    
    cacheDOM();
    
    const bakeStatus = document.getElementById('bake-status-text');

    if (roomCode) {
        setMapSeed(hashCode(roomCode));
    }

    G.renderer = createRenderer();
    document.body.appendChild(G.renderer.domElement);
    initBloom();

    G.scene = new THREE.Scene();
    G.scene.background = new THREE.Color(0xeaf4fc);
    G.scene.fog = new THREE.FogExp2(0xeaf4fc, CONFIG.fogDensity);
    
    // Container for in-flight projectiles. It sits at the origin with an
    // identity transform, so a pooled mesh's world matrix is still just its
    // local one - which is what Projectile.update() writes.
    G.pooledRoot = new THREE.Group();
    G.pooledRoot.matrixAutoUpdate = false;
    G.pooledRoot.updateMatrix();
    G.scene.add(G.pooledRoot);

    G.boxParticlePool = new ParticlePool(sharedExplosionGeo, 1500);
    G.sphereParticlePool = new ParticlePool(new THREE.IcosahedronGeometry(1, 0), 3000);
    G.scene.add(G.boxParticlePool.mesh);
    G.scene.add(G.sphereParticlePool.mesh);
    G.scene.add(G.boxParticlePool.bloomMesh);
    G.scene.add(G.sphereParticlePool.bloomMesh);

    for (let i = 0; i < MAX_PROJECTILES; i++) {
        projectilePool.push(new Projectile());
    }

    const skyGeo = new THREE.SphereGeometry(25000, 32, 32);
    const skyMat = new THREE.ShaderMaterial({
        uniforms: {
            topColor: { value: new THREE.Color(0x6ebcf0) },
            bottomColor: { value: new THREE.Color(0xeaf4fc) },
            offset: { value: 400 },
            exponent: { value: 0.6 },
            sunPosition: { value: new THREE.Vector3(800, 500, -800).normalize() }
        },
        vertexShader: `
            varying vec3 vWorldPosition;
            void main() {
                vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                vWorldPosition = worldPosition.xyz;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3 topColor;
            uniform vec3 bottomColor;
            uniform float offset;
            uniform float exponent;
            varying vec3 vWorldPosition;
            void main() {
                float h = normalize(vWorldPosition + offset).y;
                vec3 skyColor = mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0));
                gl_FragColor = vec4(skyColor, 1.0);
            }
        `,
        side: THREE.BackSide
    });
    const skyDome = new THREE.Mesh(skyGeo, skyMat);
    // The sky fills the screen behind everything else. Sorting it to the end
    // of the opaque queue means terrain has already written depth by the time
    // it draws, so most of its fragments are rejected before shading. It is
    // opaque and depth-tested either way, so the result is unchanged.
    skyDome.renderOrder = 1000;
    freezeTransform(skyDome);
    G.scene.add(skyDome);

    const sunDirToOrigin = new THREE.Vector3(-800, -500, 800).normalize();
    const sunGroup = new THREE.Group();
    const sunDist = 24000;
    sunGroup.position.copy(sunDirToOrigin).multiplyScalar(-sunDist);

    const coreGeo = new THREE.IcosahedronGeometry(600, 1);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    sunGroup.add(new THREE.Mesh(coreGeo, coreMat));

    const glowGeo1 = new THREE.IcosahedronGeometry(900, 0);
    const glowMat1 = new THREE.MeshBasicMaterial({ color: 0xffeedd, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false });
    const sunGlow1 = new THREE.Mesh(glowGeo1, glowMat1);
    sunGlow1.rotation.set(0.5, 0.5, 0.5);
    sunGroup.add(sunGlow1);

    const glowGeo2 = new THREE.IcosahedronGeometry(1300, 0);
    const glowMat2 = new THREE.MeshBasicMaterial({ color: 0xffccaa, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false });
    const sunGlow2 = new THREE.Mesh(glowGeo2, glowMat2);
    sunGlow2.rotation.set(-0.3, 0.8, -0.2);
    sunGroup.add(sunGlow2);

    freezeTransform(sunGroup);
    G.scene.add(sunGroup);
    G.scene.add(new THREE.HemisphereLight(0xfff8f0, 0x88bbdd, 1.0));

    // Same colour, intensity range and 40-unit falloff the per-plane lights
    // used. It stays in the scene for the whole match so NUM_POINT_LIGHTS is
    // pinned at 1 and no material ever needs recompiling.
    G.sharedMuzzleLight = new THREE.PointLight(0xffdd66, 0, 40);
    G.sharedMuzzleLightOwner = null;
    G.scene.add(G.sharedMuzzleLight);

    players.length = 0;
    G.localPlayer = null;
    playerList.forEach(p => {
        const isLocal = (p.id === G.socket.id);
        const player = new Player(p, isLocal);
        players.push(player);
        if (isLocal) {
            G.myPlayerIndex = p.index;
            G.localPlayer = player;
        }
    });

    const me = G.localPlayer;
    if (me) document.getElementById('hud-name').innerText = me.name;

    // Three 1024 cascades over 14000 units. With the nested-sphere fit this is
    // ~5.5 units/texel in the near cascade, ~12 in the middle and ~33 in the far
    // one - the same texel budget the cascaded setup here has always had, since
    // the artefact being fixed was a coverage failure rather than a resolution
    // one. Depth ranges, biases and the light standoff are all derived from those
    // radii inside SunShadow, so shadowRes is the only knob that has to move if
    // this ever needs to be sharper.
    G.csm = new SunShadow({
        maxFar: 14000, cascades: 3, parent: G.scene,
        shadowMapSize: CONFIG.shadowRes, lightDirection: sunDirToOrigin,
        camera: me.camera, lightIntensity: 3.2, lightColor: new THREE.Color(0xfffbdf),
        casterHeadroom: 8000
    });

    // Planes are built above, before csm exists, so the setupMaterial call that
    // mid-game joiners get in addAIPlayer had nothing to run against here. Without
    // USE_CSM a material takes three's stock directional path, which multiplies in
    // every cascade's shadow map with no cascade selection - so a plane picks up
    // shadow from cascades that do not cover it. Register them now that csm is up.
    players.forEach(p => {
        p.mesh.traverse(child => {
            if (child.isMesh && child.material) G.csm.setupMaterial(child.material);
        });
    });

    if (bakeStatus) bakeStatus.innerText = "SPINNING UP GENERATION THREAD...";
    await yieldToBrowser();

    await new Promise((resolve) => {
        const workerCode = TERRAIN_WORKER_SOURCE;
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const workerUrl = URL.createObjectURL(blob);
        const worker = new Worker(workerUrl, { type: 'module' });

        worker.onmessage = async function(e) {
            if (e.data.status) {
                if (bakeStatus) bakeStatus.innerText = e.data.status;
            } else if (e.data.done) {
                const { positions, normals, colors, pineData, decidData, rockData, shoreMap, shoreDim, shoreRange, shoreDistRange, pineCount, decidCount, rockCount } = e.data;

                buildTerrainGrid(positions);

                // PlaneGeometry lays its vertices out row-major, and after the
                // rotateX(-PI/2) in the worker index ix runs +X and iy runs +Z,
                // which is exactly the order a DataTexture wants - so this maps
                // straight onto UV space with no reshuffling. Linear filtering is
                // the point: it turns the 40-unit lattice into a continuous field,
                // which is what stops the foam snapping to quad edges.
                G.shoreTexture = new THREE.DataTexture(
                    shoreMap, shoreDim, shoreDim, THREE.RGBAFormat, THREE.UnsignedByteType
                );
                G.shoreTexture.minFilter = THREE.LinearFilter;
                G.shoreTexture.magFilter = THREE.LinearFilter;
                G.shoreTexture.wrapS = THREE.ClampToEdgeWrapping;
                G.shoreTexture.wrapT = THREE.ClampToEdgeWrapping;
                G.shoreTexture.needsUpdate = true;
                G.shoreRangeUnits = shoreRange;
                G.shoreDistRangeUnits = shoreDistRange;

                // Lambert rather than Standard. The scene is lit by one
                // HemisphereLight plus SunShadow's directionals, with no env map and no
                // IBL, so the diffuse term is mathematically the same in both
                // models - what Standard adds here is a specular lobe that
                // roughness 0.9 / metalness 0.05 had already flattened to almost
                // nothing. Terrain is the largest fill-rate consumer in the frame,
                // so this drops the most expensive fragment shader in the scene.
                const terrainMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
                G.csm.setupMaterial(terrainMaterial);
                buildChunkedTerrain(positions, normals, colors, terrainMaterial);

                if (bakeStatus) bakeStatus.innerText = "FLOODING OCEANS...";
                await yieldToBrowser();

                waterMeshes.length = 0;
                let waterGeoBase = new THREE.PlaneGeometry(CONFIG.width, CONFIG.width, 100, 100);
                const wSegSize = CONFIG.width / 100;
                const wPosBase = waterGeoBase.attributes.position;
                for (let i = 0; i < wPosBase.count; i++) {
                    let vx = wPosBase.getX(i);
                    let vy = wPosBase.getY(i);
                    vx += (Math.random() - 0.5) * wSegSize * 0.8;
                    vy += (Math.random() - 0.5) * wSegSize * 0.8;
                    wPosBase.setX(i, vx);
                    wPosBase.setY(i, vy);
                }
                // How far the sea bed sits below the surface at each vertex,
                // baked once here rather than sampled per frame. The plane is
                // authored in XY and laid flat with rotation.x = -PI/2, so a
                // local (x, y) lands at world (x, waterLevel, -y). Everything
                // the shader does that needs to know about the shoreline -
                // shoaling waves, the shallow-water tint and the foam band -
                // reads this one attribute.
                // Clamped at zero on purpose. A vertex sitting on a mountainside
                // has a bed hundreds of units *above* the surface, and letting
                // that through means a single triangle spanning a clifftop and a
                // river bed interpolates across a ~500 unit depth range. At 140
                // units per segment that put the entire width of a canyon river
                // inside the foam band, and swept the foam's ripple term through
                // dozens of cycles per triangle - which is what produced the
                // chevron banding. Land now reads as depth 0, so the gradient the
                // shader sees only ever spans real water.
                const depthBase = new Float32Array(wPosBase.count);
                for (let i = 0; i < wPosBase.count; i++) {
                    const bed = getTerrainHeight(wPosBase.getX(i), -wPosBase.getY(i));
                    depthBase[i] = Math.max(0, CONFIG.waterLevel - bed);
                }
                waterGeoBase.setAttribute('waterDepth', new THREE.BufferAttribute(depthBase, 1));

                const waterGeo = waterGeoBase.toNonIndexed();
                const wPos = waterGeo.attributes.position;
                const wCount = wPos.count;

                const waterColors = new Float32Array(wCount * 3);
                const colorDeep = new THREE.Color(0x2e8b9e);
                for (let i = 0; i < wCount; i++) {
                    waterColors[i * 3] = colorDeep.r;
                    waterColors[i * 3 + 1] = colorDeep.g;
                    waterColors[i * 3 + 2] = colorDeep.b;
                }
                waterGeo.setAttribute('color', new THREE.BufferAttribute(waterColors, 3));

                const waterMat = new THREE.MeshStandardMaterial({
                    color: 0xffffff, transparent: true, opacity: 0.82,
                    roughness: 0.2, metalness: 0.15, flatShading: true, vertexColors: true
                });

                // csm.setupMaterial installs its own onBeforeCompile to bind the cascade
                // split uniform; it must run first so the wave hook below can wrap it
                // instead of clobbering it, otherwise the water never gets USE_CSM and
                // stays unshadowed regardless of receiveShadow.
                G.csm.setupMaterial(waterMat);
                const csmOnBeforeCompile = waterMat.onBeforeCompile;
                waterMat.onBeforeCompile = (shader) => {
                    csmOnBeforeCompile(shader);
                    shader.uniforms.time = { value: 0 };
                    shader.uniforms.sunDir = { value: SUN_DIR };
                    shader.uniforms.skyReflectColor = { value: new THREE.Color(0x9fd4f5) };
                    shader.uniforms.shallowColor = { value: new THREE.Color(0x59c6c0) };
                    shader.uniforms.sunSpecColor = { value: new THREE.Color(0xfff2d8) };
                    shader.uniforms.shoreMap = { value: G.shoreTexture };
                    shader.uniforms.shoreRange = { value: G.shoreRangeUnits };
                    shader.uniforms.shoreDistRange = { value: G.shoreDistRangeUnits };
                    shader.uniforms.worldExtent = { value: CONFIG.width };
                    waterMat.userData.shader = shader;

                    // Four sine components at different headings and rates. The
                    // surface is flat-shaded, so three.js derives the normal from
                    // screen-space derivatives of the displaced position - the
                    // extra swell lights itself correctly with no normal work
                    // here and no change to the vertex count.
                    shader.vertexShader = `
                        uniform float time;
                        attribute float waterDepth;
                        varying float vWaveHeight;
                        varying vec2 vSurfXZ;
                        ${shader.vertexShader}
                    `.replace(
                        `#include <begin_vertex>`,
                        `
                        #include <begin_vertex>
                        // Swell flattens out as the bed rises, the way real
                        // water loses amplitude running into a beach.
                        float shoal = clamp(waterDepth / 70.0, 0.0, 1.0);
                        float wave = sin(position.x * 0.020 + time * 1.50) * 1.50;
                        wave += cos(position.y * 0.017 + time * 1.30) * 1.15;
                        wave += sin((position.x * 0.6 + position.y * 0.8) * 0.055 + time * 2.60) * 0.55;
                        wave += cos((position.x * 0.8 - position.y * 0.6) * 0.110 + time * 3.70) * 0.26;
                        wave *= 0.30 + 0.70 * shoal;
                        transformed.z += wave;
                        vWaveHeight = wave;
                        // Surface coordinates for the foam ripple. The plane is
                        // authored in XY, so this is world (x, -z).
                        vSurfXZ = position.xy;
                        `
                    );

                    // Injected ahead of tone mapping so these terms are added in
                    // the same linear space the lighting produced, and still go
                    // through ACES with everything else.
                    shader.fragmentShader = `
                        uniform float time;
                        uniform vec3 sunDir;
                        uniform vec3 skyReflectColor;
                        uniform vec3 shallowColor;
                        uniform vec3 sunSpecColor;
                        uniform sampler2D shoreMap;
                        uniform float shoreRange;
                        uniform float shoreDistRange;
                        uniform float worldExtent;
                        varying float vWaveHeight;
                        varying vec2 vSurfXZ;
                        ${shader.fragmentShader}
                    `.replace(
                        `#include <tonemapping_fragment>`,
                        `
                        {
                            // Everything below stays in view space: vViewPosition
                            // already points from the fragment to the camera and
                            // 'normal' is the flat-shaded face normal, so no
                            // world-space round trip is needed.
                            vec3 Nv = normalize(normal);
                            vec3 Vv = normalize(vViewPosition);
                            float fresnel = pow(1.0 - clamp(dot(Nv, Vv), 0.0, 1.0), 4.0);

                            // Grazing angles hand over to the sky colour, which is
                            // what makes distant water read as a surface rather
                            // than a flat blue sheet.
                            gl_FragColor.rgb = mix(gl_FragColor.rgb, skyReflectColor, fresnel * 0.72);

                            // Sun glitter. A tight Blinn lobe on the wave normals
                            // breaks up into sparkle for free because the normals
                            // are already per-face.
                            vec3 Lv = normalize((viewMatrix * vec4(sunDir, 0.0)).xyz);
                            float spec = pow(max(dot(Nv, normalize(Lv + Vv)), 0.0), 200.0);
                            gl_FragColor.rgb += sunSpecColor * spec * 2.4;

                            // Depth is read per fragment from the baked bed map,
                            // not interpolated from the water mesh's corners. The
                            // surface is 100 quads across 14km, so a river spans
                            // one or two vertices and a per-vertex depth made the
                            // shoreline snap to whole quads - the rectangular
                            // patches this used to produce along narrow channels.
                            vec2 shoreUV = (vec2(vSurfXZ.x, -vSurfXZ.y) + worldExtent * 0.5) / worldExtent;
                            vec2 shoreSample = texture2D(shoreMap, shoreUV).rg;
                            float shoreDepth = shoreSample.r * shoreRange;
                            float shoreDist = shoreSample.g * shoreDistRange;

                            // Shallows go turquoise, and a band of foam rides the
                            // last few metres before the shoreline.
                            float shallow = 1.0 - clamp(shoreDepth / 50.0, 0.0, 1.0);
                            gl_FragColor.rgb = mix(gl_FragColor.rgb, shallowColor, shallow * shallow * 0.8);

                            // The ripple is a function of surface position, not
                            // depth. Driving it from depth meant its frequency
                            // followed the bed gradient, so anywhere the bottom
                            // shelved steeply it aliased into hard bands.
                            //
                            // Three octaves rather than one: the long wave sets
                            // where the wash reaches, the shorter two give the
                            // edge a ragged, dissolving quality. With a single
                            // low-frequency term the band was a smooth ribbon
                            // whose outline was pure distance-field contour.
                            float ripple = 0.50 * sin(vSurfXZ.x * 0.055 + time * 2.2)
                                         + 0.50 * cos(vSurfXZ.y * 0.048 - time * 1.7)
                                         + 0.28 * sin((vSurfXZ.x + vSurfXZ.y) * 0.150 - time * 3.1)
                                         + 0.16 * cos((vSurfXZ.x - vSurfXZ.y) * 0.310 + time * 4.3);

                            // Rather than modulating the foam's brightness, the
                            // ripple pushes the waterline itself in and out, so the
                            // edge reads as a moving wash rather than a contour with
                            // a pattern painted on it. Measured in world units out
                            // from the waterline, so the band is the same width on a
                            // beach and on a canyon bank.
                            float edge = 60.0 + ripple * 15.0 + vWaveHeight * 5.0;

                            // Squared falloff: dense right at the waterline, thinning
                            // quickly on the way out, instead of a slab of even white.
                            float foam = smoothstep(edge, 0.0, shoreDist);
                            foam *= foam;
                            gl_FragColor.rgb += vec3(foam * 0.38);

                            // Foam and grazing reflections both read as more solid
                            // water, so they pull the surface towards opaque.
                            gl_FragColor.a = clamp(gl_FragColor.a + fresnel * 0.22 + foam * 0.35, 0.0, 1.0);
                        }
                        #include <tonemapping_fragment>
                        `
                    );
                };

                const mainWater = new THREE.Mesh(waterGeo, waterMat);
                mainWater.rotation.x = -Math.PI / 2;
                mainWater.position.y = CONFIG.waterLevel;
                mainWater.receiveShadow = true;
                freezeTransform(mainWater);

                G.scene.add(mainWater);
                waterMeshes.push(mainWater);

                const deepWaterGeo = new THREE.PlaneGeometry(CONFIG.width, CONFIG.width, 1, 1);
                const deepWaterMat = new THREE.MeshStandardMaterial({ color: 0x0f4055, roughness: 0.5, metalness: 0.2, flatShading: true });
                const deepWater = new THREE.Mesh(deepWaterGeo, deepWaterMat);
                deepWater.rotation.x = -Math.PI / 2;
                deepWater.position.y = CONFIG.waterLevel - 15;
                freezeTransform(deepWater);
                G.scene.add(deepWater);

                if (bakeStatus) bakeStatus.innerText = "PLANTING FORESTS...";
                await yieldToBrowser();

                G.treeGridDim = Math.ceil(CONFIG.width / TREE_GRID_SIZE);
                treeGridArr.length = 0;
                for (let i = 0; i < G.treeGridDim * G.treeGridDim; i++) treeGridArr.push([]);

                const processTree = (data, count) => {
                    for(let i=0; i<count; i++) {
                        const px = data[i*6], py = data[i*6+1], pz = data[i*6+2], pscale = data[i*6+3];
                        const gx = Math.floor((px + CONFIG.width / 2) / TREE_GRID_SIZE);
                        const gz = Math.floor((pz + CONFIG.width / 2) / TREE_GRID_SIZE);
                        if (gx >= 0 && gx < G.treeGridDim && gz >= 0 && gz < G.treeGridDim) {
                            treeGridArr[gz * G.treeGridDim + gx].push({ x: px, y: py, z: pz, r: 3.5 * pscale, h: 32 * pscale, rSq: (3.5 * pscale + 4) ** 2 });
                        }
                    }
                };
                processTree(pineData, pineCount);
                processTree(decidData, decidCount);

                // Lambert for the same reason as the terrain - roughness 0.9 meant
                // the specular contribution was already negligible.
                const instancedMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
                G.csm.setupMaterial(instancedMat);

                // One InstancedMesh per prop type carries a single bounding
                // sphere spanning the whole map, so the frustum test is
                // all-or-nothing: every cascade redrew all 15,000 trees no
                // matter how little ground it covered. The instances are now
                // bucketed into the same grid the terrain uses, so the colour
                // pass and each cascade take only the cells they overlap. The
                // geometry object is shared by every cell - instanceMatrix
                // lives on the InstancedMesh, not on the geometry.
                function buildInstancedMeshFromData(geo, data, count, isTree, castShadow) {
                    if (count === 0) return;
                    geo.computeBoundingSphere();

                    const dim = WORLD_CHUNK_DIM;
                    const cellSize = CONFIG.width / dim;
                    const halfW = CONFIG.width / 2;
                    const cellTotal = dim * dim;

                    const counts = new Uint32Array(cellTotal);
                    const cellOf = new Uint16Array(count);
                    for (let i = 0; i < count; i++) {
                        let gx = Math.floor((data[i*6] + halfW) / cellSize);
                        let gz = Math.floor((data[i*6+2] + halfW) / cellSize);
                        if (gx < 0) gx = 0; else if (gx >= dim) gx = dim - 1;
                        if (gz < 0) gz = 0; else if (gz >= dim) gz = dim - 1;
                        const cell = gz * dim + gx;
                        cellOf[i] = cell;
                        counts[cell]++;
                    }

                    const meshes = new Array(cellTotal);
                    for (let c = 0; c < cellTotal; c++) {
                        if (counts[c] === 0) continue;
                        const m = new THREE.InstancedMesh(geo, instancedMat, counts[c]);
                        m.castShadow = castShadow;
                        m.receiveShadow = true;
                        m.matrixAutoUpdate = false;
                        m.updateMatrix();
                        meshes[c] = m;
                    }

                    const cursors = new Uint32Array(cellTotal);
                    const dummy = new THREE.Object3D();
                    for(let i=0; i<count; i++) {
                        const px = data[i*6], py = data[i*6+1], pz = data[i*6+2];
                        const sx = data[i*6+3], sy = data[i*6+4], rot = data[i*6+5];
                        dummy.position.set(px, py, pz);
                        if (isTree) dummy.scale.set(sx, sy, sx);
                        else dummy.scale.setScalar(sx);
                        dummy.rotation.y = rot;
                        dummy.updateMatrix();
                        const c = cellOf[i];
                        meshes[c].setMatrixAt(cursors[c]++, dummy.matrix);
                    }

                    for (let c = 0; c < cellTotal; c++) {
                        if (!meshes[c]) continue;
                        meshes[c].computeBoundingSphere();
                        G.scene.add(meshes[c]);
                    }
                }

                if (bakeStatus) bakeStatus.innerText = "BUILDING MESHES (1/3)...";
                await yieldToBrowser();
                buildInstancedMeshFromData(createPineTreeMesh(), pineData, pineCount, true, true);

                if (bakeStatus) bakeStatus.innerText = "BUILDING MESHES (2/3)...";
                await yieldToBrowser();
                buildInstancedMeshFromData(createDeciduousTreeMesh(), decidData, decidCount, true, true);

                // Rocks are 4-unit icosahedra scattered on steep ground. Their
                // shadows are smaller than a cascade texel from any altitude the
                // game is played at, so they cost three extra passes for nothing.
                if (bakeStatus) bakeStatus.innerText = "BUILDING MESHES (3/3)...";
                await yieldToBrowser();
                buildInstancedMeshFromData(createRockMesh(), rockData, rockCount, false, false);

                resolve();
                worker.terminate();
            }
        };

        worker.postMessage({
            CONFIG,
            mapSeed: getMapSeed(),
            TREE_GRID_SIZE
        });
    });

    if (bakeStatus) bakeStatus.innerText = "DEPLOYING CLOUDS...";
    await yieldToBrowser();

    const CLOUD_COUNT = 60;
    const CLOUD_HEIGHT = 900;
    const baseCloudGeo = createCloudMesh();
    baseCloudGeo.computeBoundingSphere();
    G.cloudBaseRadiusSq = Math.pow(baseCloudGeo.boundingSphere.radius, 2);
    const maxOriginRadius = baseCloudGeo.boundingSphere.center.length() + baseCloudGeo.boundingSphere.radius;
    G.cloudMaxOriginRadiusSq = maxOriginRadius * maxOriginRadius;

    // Lambert: metalness was already 0 and roughness 0.85, so nothing of the
    // cloud's appearance depended on the PBR path. DoubleSide means every cloud
    // fragment is potentially shaded twice, which makes the saving count double.
    const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true, side: THREE.DoubleSide });
    G.cloudInstancedMesh = new THREE.InstancedMesh(baseCloudGeo, cloudMat, CLOUD_COUNT);
    G.cloudInstancedMesh.castShadow = true;
    G.cloudInstancedMesh.receiveShadow = true;

    // This non-rendered mesh is used only for exact cloud containment
    // raycasts. It shares the instance geometry and material, but lets us
    // test only nearby instances instead of raycasting every cloud.
    G.cloudRaycastMesh = new THREE.Mesh(baseCloudGeo, cloudMat);
    G.cloudRaycastMesh.matrixAutoUpdate = false;

    const dummy = new THREE.Object3D();
    for (let i = 0; i < CLOUD_COUNT; i++) {
        const cx = (Math.random() - 0.5) * CONFIG.width;
        const cz = (Math.random() - 0.5) * CONFIG.width;
        const cy = CLOUD_HEIGHT; 
        const scale = 2.0 + Math.random() * 2.5; 

        cloudsData.push({ x: cx, y: cy, z: cz, scale: scale, speed: 8 + Math.random() * 12 });

        dummy.position.set(cx, cy, cz);
        dummy.scale.setScalar(scale);
        dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
        dummy.updateMatrix();
        G.cloudInstancedMesh.setMatrixAt(i, dummy.matrix);
    }
    G.cloudInstancedMesh.matrixAutoUpdate = false;
    G.cloudInstancedMesh.updateMatrix();
    G.scene.add(G.cloudInstancedMesh);

    for (let i = 0; i < players.length; i++) {
        players[i].mesh.traverse(child => {
            child.frustumCulled = false;
            if (child.isMesh && child.material) G.csm.setupMaterial(child.material);
        });
    }

    stopUI3D();
    const uiContainer = document.getElementById('ui-3d-container');
    if(uiContainer) uiContainer.style.display = 'none';

    G.introCinematicActive = true;
    G.introCinematicTime = 0;
    G.introWireframeMesh = getUIPlane();
    G.introWireframeMesh.scale.set(0.75, 0.75, 0.75); 
    
    G.initialWireframeQuat.copy(G.introWireframeMesh.quaternion);
    G.introWireframeMesh.position.set(0, 0, 0);
    
    me.mesh.add(G.introWireframeMesh);

    // Pre-render compilation phase to eliminate First-Shot Stutter.
    // Projectiles live outside the scene graph during play, so they are
    // attached here for the duration of the warm-up and detached again below.
    G.boxParticlePool.primeWarmUp(me.mesh.position);
    G.sphereParticlePool.primeWarmUp(me.mesh.position);
    for (let i = 0; i < projectilePool.length; i++) { projectilePool[i].mesh.visible = true; attachPooled(projectilePool[i].mesh); }
    for (let i = 0; i < players.length; i++) {
        if (players[i].muzzleFlash) {
            players[i].muzzleFlash.material.opacity = 1;
            claimMuzzleLight(players[i], 150);
        }
    }

    if (bakeStatus) bakeStatus.innerText = "WARMING GPU PIPELINE...";
    warmUpAudioPipelines();
    await warmUpRenderer(me);

    G.boxParticlePool.endWarmUp();
    G.sphereParticlePool.endWarmUp();
    for (let i = 0; i < projectilePool.length; i++) { projectilePool[i].mesh.visible = false; detachPooled(projectilePool[i].mesh); }
    for (let i = 0; i < players.length; i++) {
        if (players[i].muzzleFlash) {
            players[i].muzzleFlash.material.opacity = 0;
            claimMuzzleLight(players[i], 0);
        }
    }

    // The cinematic fades the aircraft in by overriding blending state on its
    // materials. Snapshot what each one was authored with first, so the fade can
    // be undone exactly - the canopy is a transparent material at opacity 0.4,
    // and restoring a blanket 1.0 was turning the glass into painted metal.
    me.mesh.children.forEach(c => {
        if (c !== G.introWireframeMesh && c !== me.muzzleFlash) {
            c.traverse(child => {
                if (child.isMesh) {
                    const m = child.material;
                    if (!m.userData.introBase) {
                        m.userData.introBase = {
                            opacity: m.opacity,
                            transparent: m.transparent,
                            depthWrite: m.depthWrite
                        };
                    }
                    m.transparent = true;
                    m.opacity = 0;
                    m.depthWrite = false;
                }
            });
        }
    });

    if (bakeStatus) bakeStatus.innerText = "FINALIZING FLIGHT SYSTEMS...";
    await warmUpRenderer(me);

    const bakeOverlay = document.getElementById('bake-overlay');
    bakeOverlay.style.opacity = '0';
    setTimeout(() => bakeOverlay.style.display = 'none', 500); 

    const hud = document.getElementById('hud-main');
    hud.style.opacity = '0';
    hud.style.display = 'flex';
    hud.style.transition = 'opacity 1.5s ease';

    const controls = document.getElementById('controls');
    controls.style.display = 'block';
    controls.style.opacity = '0';
    controls.style.transition = 'opacity 1.5s ease';

    const leaderboard = document.getElementById('leaderboard');
    leaderboard.style.display = 'block';
    leaderboard.style.opacity = '0';
    leaderboard.style.transition = 'opacity 1.5s ease';
    
    document.getElementById('volume-control').classList.add('in-game');

    const quitBtn = document.getElementById('quit-btn');
    quitBtn.style.display = 'block';
    quitBtn.style.opacity = '0';
    quitBtn.style.transition = 'opacity 1.5s ease';

    setTimeout(() => {
        hud.style.opacity = '1';
        controls.style.opacity = '1';
        leaderboard.style.opacity = '1';
        quitBtn.style.opacity = '1';
    }, 1000); 

    G.gameActive = true;
    
    window.addEventListener('keydown', (e) => handleKey(e, true));
    window.addEventListener('keyup', (e) => handleKey(e, false));

    console.groupEnd();
    animate();
}

export { initGameWorld, warmUpRenderer };
