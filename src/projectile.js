import * as THREE from 'three';
import { BLOOM_LAYER, CONFIG, MAX_PROJECTILES } from './config.js';
import { getTerrainCellCeiling, getVisualTerrainHeight } from './terrain.js';
import { attachPooled, detachPooled } from './geometry-utils.js';

// Allocated up front by initGameWorld and reused for the whole match.
export const projectilePool = [];
let _lastProjIdx = 0;

const _sharedProjGeo = new THREE.BoxGeometry(0.3, 0.3, 4);

// toneMapped is off so tracers stay at full brightness going into the bloom
// extract; fog is off so a distant round glows yellow rather than picking up
// the near-white fog colour and blooming as a white smear.
const _sharedProjMat = new THREE.MeshBasicMaterial({ color: 0xffffaa, fog: false, toneMapped: false });
class Projectile {
    constructor() {
        this.isActive = false;
        this.ownerIdx = -1;
        this.speed = 0;
        this.life = 0;
        this.hitType = null;
        this.isLocalOrHostAI = false;
        this.mesh = new THREE.Mesh(_sharedProjGeo, _sharedProjMat);
        // enable() rather than set(): the round still draws in the main pass,
        // and picks up a glow in the bloom pass on top of it.
        this.mesh.layers.enable(BLOOM_LAYER);
        this.mesh.visible = false;
        // 250 pooled rounds live in the scene permanently; keep the renderer
        // from walking and recomposing the idle ones. They are scene-level
        // children, so world == local.
        this.mesh.matrixAutoUpdate = false;
        this.mesh.matrixWorldAutoUpdate = false;
        this.mesh.userData.childIdx = -1;
    }
    deactivate() {
        this.isActive = false;
        this.mesh.visible = false;
        detachPooled(this.mesh);
    }
    activate(ownerIdx, position, quaternion, speed, isLocalOrHostAI) {
        this.ownerIdx = ownerIdx;
        this.speed = speed + 15.0;
        this.life = 100;
        this.hitType = null;
        this.mesh.position.copy(position);
        this.mesh.quaternion.copy(quaternion);
        this.mesh.updateMatrix();
        this.mesh.matrixWorld.copy(this.mesh.matrix);
        this.mesh.visible = true;
        attachPooled(this.mesh);
        this.isActive = true;
        this.isLocalOrHostAI = isLocalOrHostAI;
    }
    update(timeScale) {
        if (!this.isActive) return false;
        this.mesh.translateZ(-this.speed * timeScale);
        this.mesh.updateMatrix();
        this.mesh.matrixWorld.copy(this.mesh.matrix);
        this.life -= 1.0 * timeScale;

        const px = this.mesh.position.x;
        const py = this.mesh.position.y;
        const pz = this.mesh.position.z;

        // While the round is above both the water plane and the tallest
        // ground in its broadphase cell, neither collision branch below can
        // fire, so the per-triangle height query is skipped outright.
        if (py >= CONFIG.waterLevel && py >= getTerrainCellCeiling(px, pz)) {
            if (this.life <= 0) {
                this.hitType = 'timeout';
                return false;
            }
            return true;
        }

        const tH = getVisualTerrainHeight(px, pz);

        if (py < CONFIG.waterLevel && tH <= CONFIG.waterLevel) {
            this.hitType = 'water';
            return false;
        } else if (py < tH) {
            this.hitType = 'dirt';
            return false;
        }

        if (this.life <= 0) {
            this.hitType = 'timeout';
            return false;
        }
        return true;
    }
}

function getProjectile() {
    for (let i = 0; i < MAX_PROJECTILES; i++) {
        _lastProjIdx = (_lastProjIdx + 1) % MAX_PROJECTILES;
        if (!projectilePool[_lastProjIdx].isActive) {
            return projectilePool[_lastProjIdx];
        }
    }
    return null;
}

export { Projectile, getProjectile };
