import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { G, cloudsData } from './state.js';

function createPineTreeMesh() {
    const trunkGeo = new THREE.CylinderGeometry(1.5, 2.5, 12, 5);
    trunkGeo.translate(0, 6, 0);
    const trunkColors = [];
    for (let i = 0; i < trunkGeo.attributes.position.count; i++) {
        trunkColors.push(0.45, 0.30, 0.18);
    }
    trunkGeo.setAttribute('color', new THREE.Float32BufferAttribute(trunkColors, 3));

    const leavesGeo = new THREE.ConeGeometry(9, 30, 5);
    leavesGeo.translate(0, 20, 0);
    const leavesColors = [];
    for (let i = 0; i < leavesGeo.attributes.position.count; i++) {
        leavesColors.push(0.22, 0.52, 0.28);
    }
    leavesGeo.setAttribute('color', new THREE.Float32BufferAttribute(leavesColors, 3));

    return BufferGeometryUtils.mergeGeometries([trunkGeo, leavesGeo]);
}

function createDeciduousTreeMesh() {
    let trunkGeo = new THREE.CylinderGeometry(1.5, 2.0, 8, 5);
    trunkGeo.translate(0, 4, 0);
    trunkGeo = trunkGeo.toNonIndexed();
    const trunkColors = [];
    for (let i = 0; i < trunkGeo.attributes.position.count; i++) {
        trunkColors.push(0.40, 0.28, 0.20);
    }
    trunkGeo.setAttribute('color', new THREE.Float32BufferAttribute(trunkColors, 3));

    let leavesGeo = new THREE.IcosahedronGeometry(7, 1);
    leavesGeo.translate(0, 10, 0);
    const leavesColors = [];
    for (let i = 0; i < leavesGeo.attributes.position.count; i++) {
        leavesColors.push(0.35, 0.65, 0.20);
    }
    leavesGeo.setAttribute('color', new THREE.Float32BufferAttribute(leavesColors, 3));

    return BufferGeometryUtils.mergeGeometries([trunkGeo, leavesGeo]);
}

function createRockMesh() {
    const rockGeo = new THREE.IcosahedronGeometry(4, 0);
    rockGeo.scale(1, 0.6, 1);
    const rockColors = [];
    for (let i = 0; i < rockGeo.attributes.position.count; i++) {
        rockColors.push(0.5, 0.48, 0.45);
    }
    rockGeo.setAttribute('color', new THREE.Float32BufferAttribute(rockColors, 3));
    return rockGeo;
}

function createCloudMesh() {
    const geometries = [];
    const parts = 10 + Math.floor(Math.random() * 6);
    const baseScale = 40 + Math.random() * 20;

    for (let i = 0; i < parts; i++) {
        const geo = new THREE.IcosahedronGeometry(baseScale * (0.5 + Math.random() * 0.7), 1);
        const tx = (Math.random() - 0.5) * baseScale * 4.0;
        const ty = Math.random() * baseScale * 0.35;
        const tz = (Math.random() - 0.5) * baseScale * 4.0;
        geo.translate(tx, ty, tz);

        const pos = geo.attributes.position;
        for (let j = 0; j < pos.count; j++) {
            if (pos.getY(j) < -baseScale * 0.15) {
                pos.setY(j, -baseScale * 0.15);
            }
        }
        geometries.push(geo);
    }
    return BufferGeometryUtils.mergeGeometries(geometries);
}

function isPointInsideCloud(point) {
    if (!G.cloudBaseRadiusSq || cloudsData.length === 0) return false;

    for (let i = 0; i < cloudsData.length; i++) {
        const cloud = cloudsData[i];
        const dx = point.x - cloud.x;
        const dy = point.y - cloud.y;
        const dz = point.z - cloud.z;
        const coreRadiusSq = G.cloudBaseRadiusSq * cloud.scale * cloud.scale * 0.65;

        if (dx * dx + dy * dy + dz * dz < coreRadiusSq) return true;
    }

    return false;
}

export { createPineTreeMesh, createDeciduousTreeMesh, createRockMesh, createCloudMesh, isPointInsideCloud };
