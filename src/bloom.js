import * as THREE from 'three';
import { BLOOM_LAYER } from './config.js';
import { G } from './state.js';

// ---------------------------------------------------------------------
// Selective bloom.
//
// A full EffectComposer would route the whole scene through a float target
// and threshold it, which on this map means the sky and the snow line bloom
// too, and costs a full-resolution copy every frame. Instead the emitters
// are tagged onto BLOOM_LAYER and drawn alone into a quarter-resolution
// target, blurred separably, and added straight over the finished frame.
// Nothing else is re-rendered and the main render path is untouched.
//
// The trade-off of layer-based extraction is that the glow is not occluded
// by geometry - an explosion directly behind a ridge still bleeds a little.
// At quarter res with this blur radius it reads as haze, and it buys us an
// extra pass that costs a few dozen instanced quads instead of a second
// pass over 15,000 trees and 350^2 terrain segments.
// ---------------------------------------------------------------------
const BLOOM_RESOLUTION_DIVISOR = 4;
let bloomRT = null;
let bloomBlurRT = null;
let bloomBlurMaterial = null;
let bloomCompositeMaterial = null;
let _bloomQuadScene = null;
let _bloomQuadCamera = null;
let _bloomQuad = null;
const _bloomClearColor = new THREE.Color(0x000000);
const _bloomPrevClearColor = new THREE.Color();

function initBloom() {
    const size = new THREE.Vector2();
    G.renderer.getDrawingBufferSize(size);
    const w = Math.max(1, Math.floor(size.x / BLOOM_RESOLUTION_DIVISOR));
    const h = Math.max(1, Math.floor(size.y / BLOOM_RESOLUTION_DIVISOR));

    const rtOpts = {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        depthBuffer: false,
        stencilBuffer: false
    };
    bloomRT = new THREE.WebGLRenderTarget(w, h, rtOpts);
    bloomBlurRT = new THREE.WebGLRenderTarget(w, h, rtOpts);

    // Nine-tap Gaussian folded into five bilinear fetches. Run once
    // horizontally and once vertically, so the kernel is 9x9 for the cost of
    // ten samples per pixel at a sixteenth of the pixel count.
    bloomBlurMaterial = new THREE.ShaderMaterial({
        uniforms: {
            tDiffuse: { value: null },
            direction: { value: new THREE.Vector2(1, 0) }
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = vec4(position.xy, 0.0, 1.0);
            }
        `,
        fragmentShader: `
            uniform sampler2D tDiffuse;
            uniform vec2 direction;
            varying vec2 vUv;
            void main() {
                vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.2270270270;
                vec2 o1 = direction * 1.3846153846;
                vec2 o2 = direction * 3.2307692308;
                sum += texture2D(tDiffuse, vUv + o1).rgb * 0.3162162162;
                sum += texture2D(tDiffuse, vUv - o1).rgb * 0.3162162162;
                sum += texture2D(tDiffuse, vUv + o2).rgb * 0.0702702703;
                sum += texture2D(tDiffuse, vUv - o2).rgb * 0.0702702703;
                gl_FragColor = vec4(sum, 1.0);
            }
        `,
        depthTest: false,
        depthWrite: false
    });

    bloomCompositeMaterial = new THREE.ShaderMaterial({
        uniforms: {
            tDiffuse: { value: bloomRT.texture },
            strength: { value: 0.85 }
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = vec4(position.xy, 0.0, 1.0);
            }
        `,
        fragmentShader: `
            uniform sampler2D tDiffuse;
            uniform float strength;
            varying vec2 vUv;
            void main() {
                gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb * strength, 1.0);
            }
        `,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthTest: false,
        depthWrite: false
    });

    _bloomQuadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    _bloomQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bloomBlurMaterial);
    _bloomQuad.frustumCulled = false;
    _bloomQuadScene = new THREE.Scene();
    _bloomQuadScene.add(_bloomQuad);
}

function resizeBloom() {
    if (!bloomRT) return;
    const size = new THREE.Vector2();
    G.renderer.getDrawingBufferSize(size);
    const w = Math.max(1, Math.floor(size.x / BLOOM_RESOLUTION_DIVISOR));
    const h = Math.max(1, Math.floor(size.y / BLOOM_RESOLUTION_DIVISOR));
    bloomRT.setSize(w, h);
    bloomBlurRT.setSize(w, h);
}

// Called immediately after the main render, with the default framebuffer
// still holding this frame's image.
function renderBloom(camera) {
    if (!bloomRT) return;

    const prevMask = camera.layers.mask;
    const prevBackground = G.scene.background;
    const prevAutoClear = G.renderer.autoClear;
    G.renderer.getClearColor(_bloomPrevClearColor);
    const prevClearAlpha = G.renderer.getClearAlpha();

    // scene.fog is deliberately left alone: nulling it flips USE_FOG on every
    // material in the scene and forces a full shader recompile each frame.
    // The emitter materials opt out of fog individually instead.
    G.scene.background = null;
    camera.layers.set(BLOOM_LAYER);
    G.renderer.setClearColor(_bloomClearColor, 0);
    G.renderer.setRenderTarget(bloomRT);
    G.renderer.clear(true, false, false);
    G.renderer.render(G.scene, camera);

    camera.layers.mask = prevMask;
    G.scene.background = prevBackground;

    const texel = bloomBlurMaterial.uniforms.direction.value;
    _bloomQuad.material = bloomBlurMaterial;
    G.renderer.autoClear = true;

    bloomBlurMaterial.uniforms.tDiffuse.value = bloomRT.texture;
    texel.set(1.0 / bloomRT.width, 0);
    G.renderer.setRenderTarget(bloomBlurRT);
    G.renderer.render(_bloomQuadScene, _bloomQuadCamera);

    bloomBlurMaterial.uniforms.tDiffuse.value = bloomBlurRT.texture;
    texel.set(0, 1.0 / bloomRT.height);
    G.renderer.setRenderTarget(bloomRT);
    G.renderer.render(_bloomQuadScene, _bloomQuadCamera);

    // Add over the frame that is already in the back buffer.
    G.renderer.setRenderTarget(null);
    G.renderer.autoClear = false;
    _bloomQuad.material = bloomCompositeMaterial;
    G.renderer.render(_bloomQuadScene, _bloomQuadCamera);

    _bloomQuad.material = bloomBlurMaterial;
    G.renderer.autoClear = prevAutoClear;
    G.renderer.setClearColor(_bloomPrevClearColor, prevClearAlpha);
}

export { initBloom, resizeBloom, renderBloom };
