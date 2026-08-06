import * as THREE from 'three';

// The wireframe aircraft that spins behind the lobby panels. It draws into its
// own WebGL context, entirely separate from the one the match uses.

// --- UI 3D WIREFRAME PLANE SYSTEM ---
let uiScene, uiCamera, uiRenderer, uiPlane;
let uiActive = true;
let uiTargetCamPos = new THREE.Vector3(14, 5, -14);
let uiTargetLookAt = new THREE.Vector3(0, 0, 0);
let uiCurrentLookAt = new THREE.Vector3(0, 0, 0);
let wireMat;

function createWireframeMesh(geo) {
    let nonIndexedGeo = geo;
    if (geo.index) {
        nonIndexedGeo = geo.toNonIndexed();
    }
    
    const posAttr = nonIndexedGeo.attributes.position;
    const numTriangles = posAttr.count / 3;
    
    const linePosArray = new Float32Array(numTriangles * 18);
    const centerArray = new Float32Array(numTriangles * 18);
    
    let outIdx = 0;
    for (let i = 0; i < numTriangles; i++) {
        const idx = i * 3;
        const ax = posAttr.getX(idx),   ay = posAttr.getY(idx),   az = posAttr.getZ(idx);
        const bx = posAttr.getX(idx+1), by = posAttr.getY(idx+1), bz = posAttr.getZ(idx+1);
        const cx = posAttr.getX(idx+2), cy = posAttr.getY(idx+2), cz = posAttr.getZ(idx+2);
        
        // Line A-B
        linePosArray[outIdx] = ax; linePosArray[outIdx+1] = ay; linePosArray[outIdx+2] = az;
        linePosArray[outIdx+3] = bx; linePosArray[outIdx+4] = by; linePosArray[outIdx+5] = bz;
        let mx = (ax+bx)/2, my = (ay+by)/2, mz = (az+bz)/2;
        centerArray[outIdx] = mx; centerArray[outIdx+1] = my; centerArray[outIdx+2] = mz;
        centerArray[outIdx+3] = mx; centerArray[outIdx+4] = my; centerArray[outIdx+5] = mz;
        outIdx += 6;
        
        // Line B-C
        linePosArray[outIdx] = bx; linePosArray[outIdx+1] = by; linePosArray[outIdx+2] = bz;
        linePosArray[outIdx+3] = cx; linePosArray[outIdx+4] = cy; linePosArray[outIdx+5] = cz;
        mx = (bx+cx)/2; my = (by+cy)/2; mz = (bz+cz)/2;
        centerArray[outIdx] = mx; centerArray[outIdx+1] = my; centerArray[outIdx+2] = mz;
        centerArray[outIdx+3] = mx; centerArray[outIdx+4] = my; centerArray[outIdx+5] = mz;
        outIdx += 6;
        
        // Line C-A
        linePosArray[outIdx] = cx; linePosArray[outIdx+1] = cy; linePosArray[outIdx+2] = cz;
        linePosArray[outIdx+3] = ax; linePosArray[outIdx+4] = ay; linePosArray[outIdx+5] = az;
        mx = (cx+ax)/2; my = (cy+ay)/2; mz = (cz+az)/2;
        centerArray[outIdx] = mx; centerArray[outIdx+1] = my; centerArray[outIdx+2] = mz;
        centerArray[outIdx+3] = mx; centerArray[outIdx+4] = my; centerArray[outIdx+5] = mz;
        outIdx += 6;
    }
    
    const wireGeo = new THREE.BufferGeometry();
    wireGeo.setAttribute('position', new THREE.BufferAttribute(linePosArray, 3));
    wireGeo.setAttribute('lineCenter', new THREE.BufferAttribute(centerArray, 3));
    
    const lines = new THREE.LineSegments(wireGeo, wireMat);
    lines.renderOrder = 999;
    return lines;
}

function initUI3D() {
    const container = document.getElementById('ui-3d-container');
    uiScene = new THREE.Scene();
    
    uiCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    uiCamera.position.copy(uiTargetCamPos);

    uiRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    uiRenderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(uiRenderer.domElement);
    resizeUI3D();

    wireMat = new THREE.ShaderMaterial({
        uniforms: {
            color: { value: new THREE.Color(0xaaaaaa) },
            opacity: { value: 0.35 },
            shrinkFactor: { value: 0.0 }
        },
        vertexShader: `
            attribute vec3 lineCenter;
            uniform float shrinkFactor;
            void main() {
                vec3 pos = mix(position, lineCenter, shrinkFactor);
                gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3 color;
            uniform float opacity;
            void main() {
                gl_FragColor = vec4(color, opacity);
            }
        `,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending
    });

    uiPlane = new THREE.Group();

    const bodyGeo = new THREE.CylinderGeometry(1.1, 0.9, 7, 10);
    bodyGeo.rotateX(Math.PI / 2);
    uiPlane.add(createWireframeMesh(bodyGeo));

    const noseGeo = new THREE.CylinderGeometry(0.9, 0.8, 3.5, 10);
    noseGeo.rotateX(Math.PI / 2);
    noseGeo.translate(0, 0, -5.25);
    uiPlane.add(createWireframeMesh(noseGeo));

    const spinnerGeo = new THREE.CylinderGeometry(0.8, 0.1, 2, 10);
    spinnerGeo.rotateX(Math.PI / 2);
    spinnerGeo.translate(0, 0, -8);
    uiPlane.add(createWireframeMesh(spinnerGeo));

    const tailBoomGeo = new THREE.CylinderGeometry(0.4, 1.1, 6, 10);
    tailBoomGeo.rotateX(Math.PI / 2);
    tailBoomGeo.translate(0, 0, 6.5);
    uiPlane.add(createWireframeMesh(tailBoomGeo));

    const cockpitGeo = new THREE.SphereGeometry(1.1, 8, 8);
    cockpitGeo.scale(1, 0.8, 2.5);
    cockpitGeo.translate(0, 0.8, -0.5);
    uiPlane.add(createWireframeMesh(cockpitGeo));

    const wGeo = new THREE.BoxGeometry(7, 0.2, 3);
    wGeo.translate(3.5, 0, 0.5);
    
    const leftWing = createWireframeMesh(wGeo);
    leftWing.position.set(0.8, -0.2, -1);
    leftWing.rotation.x = -0.05;
    leftWing.rotation.y = -0.2;
    uiPlane.add(leftWing);

    const wTipGeo = new THREE.BoxGeometry(0.5, 0.21, 3);
    wTipGeo.translate(7.25, 0, 0.5);
    const leftTip = createWireframeMesh(wTipGeo);
    leftTip.position.set(0.8, -0.2, -1);
    leftTip.rotation.x = -0.05;
    leftTip.rotation.y = -0.2;
    uiPlane.add(leftTip);

    const rightWing = createWireframeMesh(wGeo);
    rightWing.position.set(-0.8, -0.2, -1);
    rightWing.rotation.x = -0.05;
    rightWing.rotation.y = 0.2;
    rightWing.scale.x = -1;
    uiPlane.add(rightWing);

    const rightTip = createWireframeMesh(wTipGeo);
    rightTip.position.set(-0.8, -0.2, -1);
    rightTip.rotation.x = -0.05;
    rightTip.rotation.y = 0.2;
    rightTip.scale.x = -1;
    uiPlane.add(rightTip);

    const hStabGeo = new THREE.BoxGeometry(5, 0.15, 2);
    hStabGeo.translate(0, 0, 1);
    const hStab = createWireframeMesh(hStabGeo);
    hStab.position.set(0, 0.28, 8.5);
    uiPlane.add(hStab);

    const vStabGeo = new THREE.BoxGeometry(0.2, 3, 2.5);
    const pos = vStabGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (y > 0) pos.setZ(i, pos.getZ(i) + 1.5);
    }
    vStabGeo.computeVertexNormals();

    const vStab = createWireframeMesh(vStabGeo);
    vStab.position.set(0, 2.0, 8.5);
    uiPlane.add(vStab);

    const scoopGeo = new THREE.BoxGeometry(1.2, 0.6, 3);
    scoopGeo.translate(0, -0.3, 0);
    const scoop = createWireframeMesh(scoopGeo);
    scoop.position.set(0, -0.9, 1);
    uiPlane.add(scoop);

    const propeller = new THREE.Group();
    const bladeGeo = new THREE.BoxGeometry(0.18, 3.6, 0.2);
    bladeGeo.translate(0, 1.8, 0);
    for (let i = 0; i < 3; i++) {
        const blade = createWireframeMesh(bladeGeo);
        blade.rotation.z = (i / 3) * Math.PI * 2;
        propeller.add(blade);
    }
    propeller.position.set(0, 0, -9.1);
    uiPlane.add(propeller);
    uiPlane.propeller = propeller;

    uiPlane.scale.set(0.75, 0.75, 0.75);

    uiScene.add(uiPlane);
    uiAnimate();
}

function resizeUI3D() {
    if (!uiRenderer || !uiCamera) return;

    const container = document.getElementById('ui-3d-container');
    const width = container && container.clientWidth ? container.clientWidth : window.innerWidth * 0.7;
    const height = container && container.clientHeight ? container.clientHeight : window.innerHeight;

    uiCamera.aspect = width / height;
    uiCamera.updateProjectionMatrix();
    uiRenderer.setSize(width, height, false);
}

function setUICameraView(view) {
    switch(view) {
        case 'login':
            uiTargetCamPos.set(14, 5, -14); 
            uiTargetLookAt.set(0, 0, 0);
            break;
        case 'connecting':
            uiTargetCamPos.set(0, -3, -18); 
            uiTargetLookAt.set(0, 0, 0);
            break;
        case 'menu':
            uiTargetCamPos.set(12, 14, 12); 
            uiTargetLookAt.set(0, 0, 0);
            break;
        case 'waiting':
            uiTargetCamPos.set(0, 3, 20); 
            uiTargetLookAt.set(0, 0, 0);
            break;
        case 'loading':
            uiTargetCamPos.set(-10, 7, -8); 
            uiTargetLookAt.set(0, 0, 0);
            break;
    }
}

function uiAnimate() {
    if (!uiActive) return;
    requestAnimationFrame(uiAnimate);

    const time = Date.now() * 0.001;
    uiPlane.rotation.y += 0.005;
    uiPlane.rotation.z = Math.sin(time * 1.5) * 0.1;
    uiPlane.rotation.x = Math.cos(time * 1.2) * 0.05;

    if (uiPlane.propeller) {
        uiPlane.propeller.rotation.z += 0.3;
    }

    uiCamera.position.lerp(uiTargetCamPos, 0.05);
    uiCurrentLookAt.lerp(uiTargetLookAt, 0.05);
    uiCamera.lookAt(uiCurrentLookAt);

    uiCamera.translateX(-2.4);

    uiRenderer.render(uiScene, uiCamera);
    // Undo the local-space camera offset directly. This avoids allocating a
    // Vector3 on every lobby frame while leaving the camera pose unchanged.
    uiCamera.translateX(2.4);
}

// The intro cinematic reparents this mesh onto the player's plane and animates
// its shader uniforms, so both are reachable from outside.
export function getUIPlane() { return uiPlane; }
export function getWireMat() { return wireMat; }

// Stops the lobby render loop once the match takes over the screen.
export function stopUI3D() { uiActive = false; }

export { initUI3D, resizeUI3D, setUICameraView };
