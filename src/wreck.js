import * as THREE from 'three';
import { CONFIG } from './config.js';
import { G, explosions } from './state.js';
import { getVisualTerrainHeight } from './terrain.js';
import { SoundGen } from './audio.js';
import { Explosion, WaterSplash, DirtPuff } from './particles.js';

// ---------------------------------------------------------------------
// Wreckage.
//
// A downed plane is replaced by eight rigid chunks that keep the velocity
// the aircraft had at the moment of the kill, tumble, and fall under
// gravity until they hit terrain or water. The chunk geometries are built
// once and shared by every wreck; only the eight Mesh wrappers and their
// integrator state are per-death, so the cost is eight extra draw calls
// (four of which cast shadows) for the few seconds the debris is airborne.
// ---------------------------------------------------------------------
const WRECK_GRAVITY = 0.032;      // units per frame^2, at the game's 1/60s step
const WRECK_DRAG = 0.0035;        // fraction of velocity shed per frame
const WRECK_SETTLE_TIME = 4.5;    // seconds the debris lingers once it lands
const WRECK_MAX_LIFE = 9.0;       // seconds, a hard ceiling on stragglers
let _wreckChunkGeos = null;
const _wreckQuat = new THREE.Quaternion();
const _wreckVec = new THREE.Vector3();
const _wreckForward = new THREE.Vector3();

// Each chunk's geometry is centred on its own origin so it tumbles about
// itself; `origin` carries where it sat on the intact aircraft.
function buildWreckChunkGeometries() {
    if (_wreckChunkGeos) return _wreckChunkGeos;

    const nose = new THREE.CylinderGeometry(0.9, 0.8, 3.5, 8);
    nose.rotateX(Math.PI / 2);

    const midBody = new THREE.CylinderGeometry(1.1, 0.9, 7, 8);
    midBody.rotateX(Math.PI / 2);

    const tailBoom = new THREE.CylinderGeometry(0.4, 1.1, 6, 8);
    tailBoom.rotateX(Math.PI / 2);

    const wing = new THREE.BoxGeometry(7, 0.2, 3);
    const hStab = new THREE.BoxGeometry(5, 0.15, 2);

    const cockpit = new THREE.SphereGeometry(1.1, 6, 6);
    cockpit.scale(1, 0.8, 2.5);

    const spinner = new THREE.CylinderGeometry(0.8, 0.1, 2, 8);
    spinner.rotateX(Math.PI / 2);

    const vStab = new THREE.BoxGeometry(0.2, 3, 2.5);

    _wreckChunkGeos = [
        { geo: midBody,  mat: 'body',      origin: new THREE.Vector3(0, 0, 0),        big: true },
        { geo: nose,     mat: 'body',      origin: new THREE.Vector3(0, 0, -5.25),    big: true },
        { geo: tailBoom, mat: 'body',      origin: new THREE.Vector3(0, 0, 6.5),      big: true },
        { geo: wing,     mat: 'body',      origin: new THREE.Vector3(4.3, -0.2, -0.5), big: true },
        { geo: wing,     mat: 'body',      origin: new THREE.Vector3(-4.3, -0.2, -0.5), big: true },
        { geo: hStab,    mat: 'body',      origin: new THREE.Vector3(0, 0.28, 9.5),   big: false },
        { geo: vStab,    mat: 'highlight', origin: new THREE.Vector3(0, 2.0, 8.5),    big: false },
        { geo: spinner,  mat: 'highlight', origin: new THREE.Vector3(0, 0, -8),       big: false },
        { geo: cockpit,  mat: 'glass',     origin: new THREE.Vector3(0, 0.8, -0.5),   big: false }
    ];
    return _wreckChunkGeos;
}

class PlaneWreck {
    // `sourceMesh` must already have an up-to-date world matrix; `speed` is the
    // aircraft's forward speed in units per frame, before explode() zeroes it.
    constructor(sourceMesh, speed, materials) {
        this.chunks = [];
        this.particles = [];
        this.age = 0;
        this.smokeAccumulator = 0;
        this.impacted = false;

        _wreckForward.set(0, 0, -1).applyQuaternion(sourceMesh.quaternion);
        const defs = buildWreckChunkGeometries();

        for (let i = 0; i < defs.length; i++) {
            const def = defs[i];
            const mat = def.mat === 'highlight' ? materials.highlight
                      : def.mat === 'glass' ? materials.glass
                      : materials.body;

            const mesh = new THREE.Mesh(def.geo, mat);
            // Only the large pieces cast - the small ones are barely a pixel
            // of shadow each and every caster is resubmitted per cascade.
            mesh.castShadow = def.big;
            mesh.receiveShadow = false;

            mesh.position.copy(def.origin).applyMatrix4(sourceMesh.matrixWorld);
            mesh.quaternion.copy(sourceMesh.quaternion);

            // Inherited momentum, plus a blast impulse pushing each piece away
            // from the fuselage centreline so the plane visibly comes apart
            // rather than drifting along as a loose formation.
            const velocity = _wreckForward.clone().multiplyScalar(speed * 0.88);
            _wreckVec.copy(def.origin).normalize().applyQuaternion(sourceMesh.quaternion);
            velocity.addScaledVector(_wreckVec, 0.22 + Math.random() * 0.30);
            velocity.x += (Math.random() - 0.5) * 0.36;
            velocity.y += (Math.random() - 0.5) * 0.36 + 0.18;
            velocity.z += (Math.random() - 0.5) * 0.36;

            G.scene.add(mesh);
            this.chunks.push({
                mesh: mesh,
                velocity: velocity,
                spinAxis: new THREE.Vector3(
                    Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5
                ).normalize(),
                spinRate: (0.03 + Math.random() * 0.09) * (Math.random() < 0.5 ? -1 : 1),
                big: def.big,
                landed: false,
                hasImpacted: false,
                bounces: 0
            });
        }
    }

    spawnParticle(position, isFire) {
        const p = G.sphereParticlePool.get();
        if (!p) return;
        if (isFire) {
            p.material.color.setHex(Math.random() < 0.5 ? 0xff7722 : 0xffcc33);
            p.material.opacity = 0.9;
            p.scale.setScalar(1.4 + Math.random() * 1.6);
            p.userData.bloom = 1.0;
            p.userData.life = 0.55 + Math.random() * 0.3;
        } else {
            p.material.color.setHex(0x3a3a3a);
            p.material.opacity = 0.55;
            p.scale.setScalar(2.0 + Math.random() * 2.0);
            p.userData.bloom = 0.0;
            p.userData.life = 1.0;
        }
        p.position.copy(position);
        p.userData.velocity.set(
            (Math.random() - 0.5) * 0.5,
            0.25 + Math.random() * 0.35,
            (Math.random() - 0.5) * 0.5
        );
        p.userData.baseOpacity = p.material.opacity;
        p.visible = true;
        this.particles.push(p);
    }

    update(timeScale) {
        this.age += 0.016 * timeScale;

        let airborne = 0;
        const dragFactor = 1.0 - WRECK_DRAG * timeScale;

        for (let i = 0; i < this.chunks.length; i++) {
            const c = this.chunks[i];
            if (c.landed) continue;

            c.velocity.y -= WRECK_GRAVITY * timeScale;
            c.velocity.multiplyScalar(dragFactor);
            c.mesh.position.addScaledVector(c.velocity, timeScale);

            _wreckQuat.setFromAxisAngle(c.spinAxis, c.spinRate * timeScale);
            c.mesh.quaternion.multiply(_wreckQuat);

            const pos = c.mesh.position;
            const ground = getVisualTerrainHeight(pos.x, pos.z);
            const overWater = ground < CONFIG.waterLevel;
            const floor = overWater ? CONFIG.waterLevel : ground;

            if (pos.y <= floor) {
                pos.y = floor;

                if (!c.hasImpacted) {
                    c.hasImpacted = true;
                    if (overWater) {
                        explosions.push(new WaterSplash(pos));
                    } else {
                        explosions.push(new DirtPuff(pos));
                    }
                    // One report for the whole wreck, from whichever piece
                    // lands first, rather than nine overlapping impacts.
                    if (!this.impacted) {
                        this.impacted = true;
                        explosions.push(new Explosion(pos, 0xff8800));
                        SoundGen.playExplosion(pos);
                    }
                }

                // A couple of damped bounces, then the piece settles. Without
                // this a plane flown straight into a hillside would have every
                // chunk touch down on the first frame and the wreck would be
                // gone before it was ever visible.
                if (c.bounces < 2 && Math.abs(c.velocity.y) > 0.25) {
                    c.bounces++;
                    c.velocity.y = Math.abs(c.velocity.y) * 0.32;
                    c.velocity.x *= 0.55;
                    c.velocity.z *= 0.55;
                    c.spinRate *= 0.45;
                    airborne++;
                } else {
                    c.landed = true;
                    c.velocity.set(0, 0, 0);
                }
            } else {
                airborne++;
            }
        }

        // Fire and smoke stream off the large pieces while they fall.
        this.smokeAccumulator += timeScale;
        if (this.smokeAccumulator >= 2.0 && this.age < 6.0) {
            this.smokeAccumulator = 0;
            for (let i = 0; i < this.chunks.length; i++) {
                const c = this.chunks[i];
                if (!c.big || c.landed) continue;
                this.spawnParticle(c.mesh.position, Math.random() < 0.45);
            }
        }

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.userData.life -= 0.022 * timeScale;
            p.position.addScaledVector(p.userData.velocity, timeScale);
            p.scale.multiplyScalar(1.0 + 0.035 * timeScale);
            p.material.opacity = Math.max(0, p.userData.life) * p.userData.baseOpacity;
            if (p.userData.life <= 0) {
                G.sphereParticlePool.release(p);
                this.particles[i] = this.particles[this.particles.length - 1];
                this.particles.pop();
            }
        }

        if (this.age > WRECK_MAX_LIFE) return false;
        // Settled wreckage is left lying on the ground for a beat rather than
        // blinking out the moment the last piece stops moving.
        return this.age < WRECK_SETTLE_TIME || airborne > 0 || this.particles.length > 0;
    }

    dispose() {
        for (let i = 0; i < this.chunks.length; i++) {
            G.scene.remove(this.chunks[i].mesh);
        }
        this.chunks.length = 0;
        for (let i = 0; i < this.particles.length; i++) {
            G.sphereParticlePool.release(this.particles[i]);
        }
        this.particles.length = 0;
    }
}

export { PlaneWreck };
