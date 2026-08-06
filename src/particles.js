import * as THREE from 'three';
import { BLOOM_LAYER, CONFIG } from './config.js';
import { G } from './state.js';

// Geometry for the box-shaped debris pool, shared with the pool's InstancedMesh.
export const sharedExplosionGeo = new THREE.BoxGeometry(0.4, 0.4, 0.4);

// --- PARTICLE POOLING SYSTEM ---
const _particleProjScreen = new THREE.Matrix4();
const _particleVec = new THREE.Vector3();
const _particleQuat = new THREE.Quaternion();
const _particleMatrix = new THREE.Matrix4();
// Farthest first, matching three.js's reversePainterSortStable for transparent
// objects, so overlapping particles blend in the order they always did.
const _particleDepthSort = (a, b) => b._z - a._z;

// A pooled particle used to be a THREE.Mesh carrying its own material. With
// ~500 of them alive during a fight that cost about 7ms per frame on an Iris
// Xe: each one is an object to walk, frustum-test and depth-sort, and a
// material switch plus a fresh uniform upload at draw time.
//
// They are now instances of one InstancedMesh per pool - two draw calls for
// the entire particle system. Colour rides on the standard instanceColor
// attribute and per-particle alpha on a custom one, so every particle keeps
// its own tint and fade curve. Everything the effect classes touch
// (position/rotation/scale/material.color/material.opacity/visible/userData)
// is still here, so their update code is unchanged.
class PooledParticle {
    constructor() {
        this.position = new THREE.Vector3();
        this.rotation = new THREE.Euler();
        this.scale = new THREE.Vector3(1, 1, 1);
        this.material = { color: new THREE.Color(0xffffff), opacity: 1 };
        this.visible = false;
        this._z = 0;
        this.userData = {
            velocity: new THREE.Vector3(),
            rotSpeed: 0,
            life: 0,
            baseOpacity: 1,
            isFlame: false,
            isWater: false,
            // 0 = never contributes to the bloom pass, 1 = full contribution.
            // Lets fire and dirt share one pool without dirt glowing.
            bloom: 0,
            poolItem: null
        };
    }
}

class ParticlePool {
    constructor(geometry, maxSize) {
        this.items = [];
        // A min-heap of inactive entries. The old linear scan always chose
        // the lowest available slot, so keeping this order preserves which
        // particle is selected while making get() logarithmic.
        this.freeItems = [];
        this.activeList = [];
        this.maxSize = maxSize;
        this._order = [];

        this.material = new THREE.MeshBasicMaterial({ transparent: true });
        this.material.customProgramCacheKey = () => 'instancedParticleAlpha';
        this.material.onBeforeCompile = (shader) => {
            shader.vertexShader = 'attribute float instanceAlpha;\nvarying float vInstanceAlpha;\n' +
                shader.vertexShader.replace(
                    '#include <begin_vertex>',
                    '#include <begin_vertex>\n\tvInstanceAlpha = instanceAlpha;'
                );
            // The instance tint is handled by three.js itself: enabling
            // instanceColor makes it define USE_COLOR for the fragment stage,
            // so its own colour chunks multiply vColor into diffuseColor.
            // Only the per-instance alpha needs adding here.
            shader.fragmentShader = 'varying float vInstanceAlpha;\n' +
                shader.fragmentShader.replace(
                    'vec4 diffuseColor = vec4( diffuse, opacity );',
                    'vec4 diffuseColor = vec4( diffuse, opacity * vInstanceAlpha );'
                );
        };

        this.mesh = new THREE.InstancedMesh(geometry, this.material, maxSize);
        this.mesh.count = 0;
        // One bounding volume around thousands of scattered particles culls
        // nothing useful; skip the test rather than risk a stale sphere.
        this.mesh.frustumCulled = false;
        this.mesh.matrixAutoUpdate = false;
        this.mesh.updateMatrix();
        // Drawn after the other transparent surfaces, which is the order that
        // matters: particles are almost always in front of the water and the
        // canopy glass, and need to blend over them.
        this.mesh.renderOrder = 10;
        this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(maxSize * 3), 3);
        this.alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(maxSize), 1);
        geometry.setAttribute('instanceAlpha', this.alphaAttr);
        this.bloomAttr = new THREE.InstancedBufferAttribute(new Float32Array(maxSize), 1);
        geometry.setAttribute('instanceBloom', this.bloomAttr);

        // A twin that reuses the *same* instance buffers - commit() fills them
        // once and both meshes read them, so the bloom pass adds no per-particle
        // CPU work. It only exists on BLOOM_LAYER, so the main camera skips it
        // and the bloom camera sees nothing else from this pool.
        this.bloomMaterial = new THREE.MeshBasicMaterial({
            fog: false,
            toneMapped: false,
            depthWrite: false,
            depthTest: false,
            transparent: true,
            blending: THREE.CustomBlending,
            blendSrc: THREE.OneFactor,
            blendDst: THREE.OneFactor
        });
        this.bloomMaterial.customProgramCacheKey = () => 'instancedParticleBloom';
        this.bloomMaterial.onBeforeCompile = (shader) => {
            shader.vertexShader = 'attribute float instanceAlpha;\nattribute float instanceBloom;\nvarying float vBloomWeight;\n' +
                shader.vertexShader.replace(
                    '#include <begin_vertex>',
                    '#include <begin_vertex>\n\tvBloomWeight = instanceAlpha * instanceBloom;'
                );
            // Output is already premultiplied, which is why the blend factors
            // above are One/One rather than SrcAlpha/One.
            shader.fragmentShader = 'varying float vBloomWeight;\n' +
                shader.fragmentShader.replace(
                    'vec4 diffuseColor = vec4( diffuse, opacity );',
                    'vec4 diffuseColor = vec4( diffuse * vBloomWeight * 1.9, 1.0 );'
                );
        };

        this.bloomMesh = new THREE.InstancedMesh(geometry, this.bloomMaterial, maxSize);
        this.bloomMesh.instanceMatrix = this.mesh.instanceMatrix;
        this.bloomMesh.instanceColor = this.mesh.instanceColor;
        this.bloomMesh.count = 0;
        this.bloomMesh.frustumCulled = false;
        this.bloomMesh.matrixAutoUpdate = false;
        this.bloomMesh.updateMatrix();
        this.bloomMesh.layers.set(BLOOM_LAYER);

        for (let i = 0; i < maxSize; i++) {
            const p = new PooledParticle();
            const item = { mesh: p, active: false, poolIndex: i, activeIdx: -1 };
            // Pool releases occur in particle update loops. Retaining the
            // owning item avoids a linear search through up to 3,000 entries
            // for every released particle, while preserving allocation order.
            p.userData.poolItem = item;
            this.items.push(item);
            this.freeItems.push(item);
        }
    }
    get() {
        const heap = this.freeItems;
        if (heap.length === 0) return null;

        const item = heap[0];
        const last = heap.pop();
        if (heap.length > 0) {
            let i = 0;
            while (true) {
                const left = i * 2 + 1;
                if (left >= heap.length) break;
                const right = left + 1;
                const child = right < heap.length && heap[right].poolIndex < heap[left].poolIndex ? right : left;
                if (last.poolIndex <= heap[child].poolIndex) break;
                heap[i] = heap[child];
                i = child;
            }
            heap[i] = last;
        }
        item.active = true;
        item.activeIdx = this.activeList.length;
        this.activeList.push(item);
        return item.mesh;
    }
    release(mesh) {
        mesh.visible = false;
        const item = mesh.userData.poolItem;
        if (!item || !item.active) return;

        item.active = false;

        const al = this.activeList;
        const ai = item.activeIdx;
        const lastActive = al[al.length - 1];
        al[ai] = lastActive;
        lastActive.activeIdx = ai;
        al.pop();
        item.activeIdx = -1;

        const heap = this.freeItems;
        let i = heap.length;
        heap.push(item);
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (heap[parent].poolIndex <= item.poolIndex) break;
            heap[i] = heap[parent];
            i = parent;
        }
        heap[i] = item;
    }
    // Writes the live particles into the instance buffers, back to front.
    commit(camera) {
        const list = this.activeList;
        const order = this._order;
        order.length = 0;

        if (list.length > 0) {
            _particleProjScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
            for (let i = 0; i < list.length; i++) {
                const p = list[i].mesh;
                if (!p.visible) continue;
                _particleVec.copy(p.position).applyMatrix4(_particleProjScreen);
                p._z = _particleVec.z;
                order.push(p);
            }
            order.sort(_particleDepthSort);
        }

        const count = order.length;
        this.mesh.count = count;
        this.bloomMesh.count = count;
        if (count === 0) return;

        const mArr = this.mesh.instanceMatrix.array;
        const cArr = this.mesh.instanceColor.array;
        const aArr = this.alphaAttr.array;
        const bArr = this.bloomAttr.array;

        for (let i = 0; i < count; i++) {
            const p = order[i];
            _particleQuat.setFromEuler(p.rotation);
            _particleMatrix.compose(p.position, _particleQuat, p.scale);
            _particleMatrix.toArray(mArr, i * 16);
            const c = p.material.color;
            const c3 = i * 3;
            cArr[c3] = c.r; cArr[c3 + 1] = c.g; cArr[c3 + 2] = c.b;
            aArr[i] = p.material.opacity;
            bArr[i] = p.userData.bloom;
        }

        // Only the slots actually in use are re-uploaded.
        this.mesh.instanceMatrix.needsUpdate = true;
        this.mesh.instanceMatrix.updateRange.count = count * 16;
        this.mesh.instanceColor.needsUpdate = true;
        this.mesh.instanceColor.updateRange.count = count * 3;
        this.alphaAttr.needsUpdate = true;
        this.alphaAttr.updateRange.count = count;
        this.bloomAttr.needsUpdate = true;
        this.bloomAttr.updateRange.count = count;
    }
    // Puts a few instances on screen so the driver builds the real pipeline
    // during the loading screen rather than on the first explosion.
    primeWarmUp(position) {
        const n = Math.min(4, this.maxSize);
        const mArr = this.mesh.instanceMatrix.array;
        const cArr = this.mesh.instanceColor.array;
        for (let i = 0; i < n; i++) {
            _particleMatrix.makeTranslation(position.x, position.y, position.z);
            _particleMatrix.toArray(mArr, i * 16);
            cArr[i * 3] = 1; cArr[i * 3 + 1] = 1; cArr[i * 3 + 2] = 1;
            this.alphaAttr.array[i] = 0.01;
            this.bloomAttr.array[i] = 0.01;
        }
        this.mesh.count = n;
        this.bloomMesh.count = n;
        this.mesh.instanceMatrix.needsUpdate = true;
        this.mesh.instanceColor.needsUpdate = true;
        this.alphaAttr.needsUpdate = true;
        this.bloomAttr.needsUpdate = true;
    }
    endWarmUp() {
        this.mesh.count = 0;
        this.bloomMesh.count = 0;
    }
}


class Explosion {
    constructor(position, color) {
        this.particles = [];
        const particleCount = 12;
        for (let i = 0; i < particleCount; i++) {
            const mesh = G.boxParticlePool.get();
            if (!mesh) continue;
            mesh.material.color.setHex(color);
            mesh.material.opacity = 1.0;
            mesh.position.copy(position);
            mesh.userData.velocity.set(
                (Math.random() - 0.5) * 2,
                (Math.random() - 0.5) * 2,
                (Math.random() - 0.5) * 2
            );
            mesh.userData.life = 1.0;
            mesh.userData.rotSpeed = (Math.random() - 0.5) * 0.2;
            mesh.userData.bloom = 1.0;
            mesh.visible = true;
            this.particles.push(mesh);
        }
    }
    update(timeScale) {
        let active = false;
        for (let i = 0; i < this.particles.length; i++) {
            let p = this.particles[i];
            if (p.userData.life > 0) {
                p.position.addScaledVector(p.userData.velocity, timeScale);
                p.rotation.x += p.userData.rotSpeed * timeScale;
                p.userData.life -= 0.03 * timeScale;
                p.scale.setScalar(p.userData.life * 3);
                // Fading the alpha as well as the scale means the glow this
                // feeds into the bloom pass ramps down instead of popping out.
                p.material.opacity = Math.min(1.0, p.userData.life * 1.6);
                active = true;
            } else if (p.visible) { 
                G.boxParticlePool.release(p); 
            }
        }
        return active;
    }
    dispose() {
        for (let i = 0; i < this.particles.length; i++) {
            let p = this.particles[i];
            if (p.visible) G.boxParticlePool.release(p);
        }
    }
}

class WaterSplash {
    constructor(position) {
        this.particles = [];
        const particleCount = 8;
        for (let i = 0; i < particleCount; i++) {
            const mesh = G.boxParticlePool.get();
            if (!mesh) continue;
            mesh.material.color.setHex(0xddffff);
            mesh.material.opacity = 0.8;
            mesh.position.copy(position);
            mesh.position.y = CONFIG.waterLevel;
            mesh.userData.velocity.set(
                (Math.random() - 0.5) * 2.0,
                1.0 + Math.random() * 2.0,
                (Math.random() - 0.5) * 2.0
            );
            mesh.userData.life = 1.0;
            mesh.userData.rotSpeed = (Math.random() - 0.5) * 0.4;
            mesh.userData.bloom = 0.0;
            mesh.visible = true;
            this.particles.push(mesh);
        }
    }
    update(timeScale) {
        let active = false;
        for (let i = 0; i < this.particles.length; i++) {
            let p = this.particles[i];
            if (p.userData.life > 0) {
                p.userData.velocity.y -= 0.15 * timeScale;
                p.position.addScaledVector(p.userData.velocity, timeScale);
                p.rotation.x += p.userData.rotSpeed * timeScale;
                p.userData.life -= 0.04 * timeScale;
                p.scale.setScalar(p.userData.life * 1.5);
                p.material.opacity = p.userData.life * 0.8;
                active = true;
            } else if (p.visible) { 
                G.boxParticlePool.release(p); 
            }
        }
        return active;
    }
    dispose() {
        for (let i = 0; i < this.particles.length; i++) {
            let p = this.particles[i];
            if (p.visible) G.boxParticlePool.release(p);
        }
    }
}

class DirtPuff {
    constructor(position) {
        this.particles = [];
        const particleCount = 6;
        for (let i = 0; i < particleCount; i++) {
            const mesh = G.boxParticlePool.get();
            if (!mesh) continue;
            mesh.material.color.setHex(0x4a3525);
            mesh.material.opacity = 1.0;
            mesh.position.copy(position);
            mesh.userData.velocity.set(
                (Math.random() - 0.5) * 1.5,
                0.5 + Math.random() * 1.5,
                (Math.random() - 0.5) * 1.5
            );
            mesh.userData.life = 1.0;
            mesh.userData.rotSpeed = (Math.random() - 0.5) * 0.4;
            mesh.userData.bloom = 0.0;
            mesh.visible = true;
            this.particles.push(mesh);
        }
    }
    update(timeScale) {
        let active = false;
        for (let i = 0; i < this.particles.length; i++) {
            let p = this.particles[i];
            if (p.userData.life > 0) {
                p.userData.velocity.y -= 0.08 * timeScale;
                p.position.addScaledVector(p.userData.velocity, timeScale);
                p.rotation.x += p.userData.rotSpeed * timeScale;
                p.userData.life -= 0.05 * timeScale;
                p.scale.setScalar(p.userData.life * 2.0);
                p.material.opacity = p.userData.life;
                active = true;
            } else if (p.visible) { 
                G.boxParticlePool.release(p); 
            }
        }
        return active;
    }
    dispose() {
        for (let i = 0; i < this.particles.length; i++) {
            let p = this.particles[i];
            if (p.visible) G.boxParticlePool.release(p);
        }
    }
}

export { PooledParticle, ParticlePool, Explosion, WaterSplash, DirtPuff };
