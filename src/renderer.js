import * as THREE from 'three';

function createRenderer() {
    const r = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: "high-performance",
        // three.js allocates a stencil buffer by default. Nothing here uses
        // one, and dropping it turns the MSAA depth attachment from D24S8
        // into a plain depth buffer - straight bandwidth savings on an iGPU
        // that shares memory with the CPU.
        stencil: false
    });
    r.setSize(window.innerWidth, window.innerHeight);
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.3;
    return r;
}

export { createRenderer };
