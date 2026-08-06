import * as THREE from 'three';
import { CONFIG, ENGINE_PARAM_INTERVAL, INTRO_DURATION } from './config.js';
import { G, players, explosions, waterMeshes, cloudsData, targetWireframeQuat } from './state.js';
import {
    _tempVec, _tempDiff, _raycaster, _rayDirUp, _instanceMatrix, _normalMatrix,
    _cloudIntersections, _cloudDummy, _cineDummyCam, _cineStartOffset,
    _cineLocalLookAt, _cineEndLookAt, _audioForward, _audioUp
} from './scratch.js';
import { audioCtx, SoundGen } from './audio.js';
import { getWireMat, resizeUI3D } from './ui-3d.js';
import { updateSharedMuzzleLight } from './muzzle-light.js';
import { Explosion, WaterSplash, DirtPuff } from './particles.js';
import { projectilePool } from './projectile.js';
import { simulateAI } from './ai.js';
import { inputState } from './input.js';
import { _DOM, _hudCache, updateHUD } from './hud.js';
import { renderBloom, resizeBloom } from './bloom.js';

const clock = new THREE.Clock();

let _nextListenerUpdate = 0;

// Wingspan is roughly 16 units and the fuselage 18 long, so this fires a little
// before two models visibly overlap - close enough to read as a clip, loose
// enough that the 75ms interpolation delay on remote planes cannot make the two
// clients disagree about whether contact happened.
const PLANE_COLLISION_RADIUS_SQ = 15 * 15;
const _collisionDeaths = [];

function isFlying(p) {
    if (p.isCrashed || p.disconnected) return false;
    return p.isLocal ? !G.introCinematicActive : p.isSpawned;
}

function isSimulatedLocally(p) {
    return p.isLocal || (G.isHost && p.isAI);
}

function animate() {
    requestAnimationFrame(animate);
    if (!G.gameActive) return;

    const delta = clock.getDelta();
    const timeScale = Math.min(delta, 0.1) * 60;
    const elapTime = clock.getElapsedTime();

    if (waterMeshes.length > 0 && waterMeshes[0].material.userData.shader) {
        waterMeshes[0].material.userData.shader.uniforms.time.value = elapTime;
    }

    if (G.cloudInstancedMesh) {
        const cloudDelta = Math.min(delta, 0.1);
        for (let i = 0; i < cloudsData.length; i++) {
            const c = cloudsData[i];
            c.x -= c.speed * cloudDelta;
            if (c.x < -CONFIG.width / 2) c.x = CONFIG.width / 2;
            _cloudDummy.position.set(c.x, c.y, c.z);
            _cloudDummy.scale.setScalar(c.scale);
            _cloudDummy.rotation.set(0, 0, 0);
            _cloudDummy.updateMatrix();
            G.cloudInstancedMesh.setMatrixAt(i, _cloudDummy.matrix);
        }
        G.cloudInstancedMesh.instanceMatrix.needsUpdate = true;
    }

    const me = G.localPlayer;

    for (let i = 0; i < players.length; i++) {
        let p = players[i];
        if (p.disconnected) continue; 

        if (p.index === G.myPlayerIndex) {
            p.updatePhysics(timeScale);
        } else if (p.isAI && G.isHost) {
            simulateAI(p, timeScale);
            p.updatePhysics(timeScale);
        } else {
            p.interpolatePosition();
        }
        
        p.updateVisuals(timeScale);
    }

    // Mid-air collisions. Both aircraft are destroyed, and neither pilot is
    // credited with a kill. Each client resolves this only for the planes it
    // simulates - its own, plus the AI if it is the host - and the other party
    // runs the identical test against the same two positions, so both go down
    // without needing a new message type. Pairs are collected before anything
    // dies so that a host owning both halves of a collision still kills each
    // of them; killing in place would make the first death hide the second's
    // collision partner.
    _collisionDeaths.length = 0;
    for (let i = 0; i < players.length; i++) {
        const a = players[i];
        if (!isFlying(a)) continue;
        for (let j = i + 1; j < players.length; j++) {
            const b = players[j];
            if (!isFlying(b)) continue;
            if (a.mesh.position.distanceToSquared(b.mesh.position) >= PLANE_COLLISION_RADIUS_SQ) continue;

            if (isSimulatedLocally(a) && _collisionDeaths.indexOf(a) === -1) _collisionDeaths.push(a);
            if (isSimulatedLocally(b) && _collisionDeaths.indexOf(b) === -1) _collisionDeaths.push(b);
        }
    }
    for (let i = 0; i < _collisionDeaths.length; i++) {
        const p = _collisionDeaths[i];
        p.diedByCollision = true;
        p.die(-1);
    }

    for (let i = 0; i < projectilePool.length; i++) {
        const proj = projectilePool[i];
        if (!proj.isActive) continue;
        if (!proj.update(timeScale)) {
            if (proj.hitType === 'water') {
                explosions.push(new WaterSplash(proj.mesh.position));
                SoundGen.playBulletWaterHit(proj.mesh.position);
            } else if (proj.hitType === 'dirt') {
                explosions.push(new DirtPuff(proj.mesh.position));
                SoundGen.playBulletDirtHit(proj.mesh.position);
            } else if (proj.life > 0 && proj.hitType !== 'timeout') {
                explosions.push(new Explosion(proj.mesh.position, 0xffff00));
                SoundGen.playExplosion(proj.mesh.position);
            }
            proj.deactivate();
            continue;
        }
        if (proj.ownerIdx === G.myPlayerIndex || proj.isLocalOrHostAI) {
            for (let j = 0; j < players.length; j++) {
                let p = players[j];
                const isTargetSpawned = p.isLocal ? !G.introCinematicActive : p.isSpawned;
                if (p.index !== proj.ownerIdx && !p.isCrashed && isTargetSpawned && !p.disconnected) {
                    if (proj.mesh.position.distanceTo(p.mesh.position) < 12) {
                        explosions.push(new Explosion(proj.mesh.position, 0xffaa00));
                        SoundGen.playExplosion(proj.mesh.position);
                        proj.deactivate();
                        const hitData = { type: 'HIT_EVENT', targetIdx: p.index, attackerIdx: proj.ownerIdx, dmg: 15 };
                        if (G.isHost) {
                            G.socket.emit('host_broadcast', { roomCode: G.myRoomCode, data: hitData });
                            let target = null;
                            for (let k = 0; k < players.length; k++) {
                                if (players[k].index === p.index) { target = players[k]; break; }
                            }
                            if (target && (target.index === G.myPlayerIndex || target.isAI)) {
                                target.takeDamage(hitData.dmg, proj.ownerIdx);
                            }
                        } else {
                            G.socket.emit('client_send', { roomCode: G.myRoomCode, data: hitData });
                        }
                        break;
                    }
                }
            }
        }
    }

    // O(1) Array Swap & Pop to eliminate array shift re-allocations
    for (let i = explosions.length - 1; i >= 0; i--) {
        if (!explosions[i].update(timeScale)) {
            explosions[i].dispose();
            explosions[i] = explosions[explosions.length - 1];
            explosions.pop();
        }
    }

    if (me && me.mesh) {
        me.mesh.updateMatrixWorld();

        if (inputState.lookBack) {
            _tempVec.set(0, 6, -25).applyMatrix4(me.mesh.matrixWorld);
        } else {
            _tempVec.set(0, 6, 18).applyMatrix4(me.mesh.matrixWorld);
        }
        const lerpFactor = 1.0 - Math.pow(0.8, timeScale);

        if (!me.virtualChasePos) {
            me.virtualChasePos = _tempVec.clone();
        } else {
            me.virtualChasePos.lerp(_tempVec, lerpFactor);
        }

        if (G.introCinematicActive) {
            G.introCinematicTime += delta;
            let progress = G.introCinematicTime / INTRO_DURATION;
            
            if (progress >= 1.0) {
                progress = 1.0;
                G.introCinematicActive = false;
                G.introWireframeMesh.visible = false; 
                me.camera.clearViewOffset();
                me.camera.fov = 60;
                me.camera.updateProjectionMatrix();
                
                me.mesh.children.forEach(c => {
                    // Prevent the muzzle flash from being forced to 1.0 opacity
                    if (c !== G.introWireframeMesh && c !== me.muzzleFlash) {
                        c.traverse(child => {
                            if (child.isMesh && child.material) {
                                const base = child.material.userData.introBase;
                                child.material.opacity = base ? base.opacity : 1.0;
                                child.material.transparent = base ? base.transparent : false;
                                child.material.depthWrite = base ? base.depthWrite : true;
                            }
                        });
                    }
                });
            }
            
            const moveProgress = Math.min(Math.max(progress / 0.6, 0.0), 1.0);
            const fadeProgress = Math.min(Math.max((progress - 0.6) / 0.2, 0.0), 1.0);
            const shrinkProgress = Math.min(Math.max((progress - 0.8) / 0.2, 0.0), 1.0);

            const easeCubicInOut = moveProgress < 0.5 ? 4 * moveProgress * moveProgress * moveProgress : 1 - Math.pow(-2 * moveProgress + 2, 3) / 2;
            G.introWireframeMesh.quaternion.slerpQuaternions(G.initialWireframeQuat, targetWireframeQuat, easeCubicInOut);
            if (G.introWireframeMesh.propeller) {
                G.introWireframeMesh.propeller.rotation.z += (0.3 + (me.speed * 0.5)) * timeScale;
            }

            getWireMat().uniforms.shrinkFactor.value = shrinkProgress;
            getWireMat().uniforms.opacity.value = 0.35; 
            
            me.mesh.children.forEach(c => {
                if (c !== G.introWireframeMesh && c !== me.muzzleFlash) {
                    c.traverse(child => {
                        if (child.isMesh && child.material) {
                            // Scaled by the authored opacity so the canopy fades
                            // in towards its own 0.4, not towards fully opaque.
                            const base = child.material.userData.introBase;
                            child.material.opacity = fadeProgress * (base ? base.opacity : 1.0);
                        }
                    });
                }
            });
            
            _cineDummyCam.position.set(-10, 7, -8);
            _cineDummyCam.lookAt(0, 0, 0);
            _cineDummyCam.translateX(-2.4);
            
            _cineStartOffset.copy(_cineDummyCam.position).applyMatrix4(me.mesh.matrixWorld); 
            const currentPos = _cineStartOffset.lerp(me.virtualChasePos, easeCubicInOut);
            me.camera.position.copy(currentPos);
            
            _tempVec.set(0, 0, -10).applyQuaternion(_cineDummyCam.quaternion);
            _cineLocalLookAt.copy(_cineDummyCam.position).add(_tempVec);
            _cineLocalLookAt.applyMatrix4(me.mesh.matrixWorld); 
            
            _cineEndLookAt.set(0, 0, -30).applyMatrix4(me.mesh.matrixWorld);
            _cineLocalLookAt.lerp(_cineEndLookAt, easeCubicInOut);
            
            me.camera.lookAt(_cineLocalLookAt);
            
            const baseScale = 0.75 + (0.25 * easeCubicInOut);
            G.introWireframeMesh.scale.set(baseScale, baseScale, baseScale);

            me.camera.fov = 45 + (15 * easeCubicInOut);
            me.camera.updateProjectionMatrix();
            if (G.csm) G.csm.updateFrustums();

            const W = window.innerWidth;
            const H = window.innerHeight;
            const shiftX = -0.15 * W * (1.0 - easeCubicInOut);
            
            if (Math.abs(shiftX) < 0.5) {
                me.camera.clearViewOffset();
            } else {
                me.camera.setViewOffset(W, H, shiftX, 0, W, H);
            }
            
        } else {
            me.camera.position.copy(me.virtualChasePos);
            if (inputState.lookBack) {
                _tempDiff.set(0, 0, 30).applyMatrix4(me.mesh.matrixWorld);
            } else {
                _tempDiff.set(0, 0, -30).applyMatrix4(me.mesh.matrixWorld);
            }
            me.camera.lookAt(_tempDiff);
        }

        // Same reasoning as the engine automation: the listener is driven with
        // a 0.1s time constant, so a ~30Hz refresh is inaudible next to a
        // per-frame one and removes nine scheduled events every frame.
        const nowMs = performance.now();
        if (audioCtx.listener.positionX && nowMs >= _nextListenerUpdate) {
            _nextListenerUpdate = nowMs + ENGINE_PARAM_INTERVAL;
            const camPos = me.camera.position;
            const camQuat = me.camera.quaternion;
            _audioForward.set(0, 0, -1).applyQuaternion(camQuat);
            _audioUp.set(0, 1, 0).applyQuaternion(camQuat);
            const t = audioCtx.currentTime;
            audioCtx.listener.positionX.setTargetAtTime(camPos.x, t, 0.1);
            audioCtx.listener.positionY.setTargetAtTime(camPos.y, t, 0.1);
            audioCtx.listener.positionZ.setTargetAtTime(camPos.z, t, 0.1);
            audioCtx.listener.forwardX.setTargetAtTime(_audioForward.x, t, 0.1);
            audioCtx.listener.forwardY.setTargetAtTime(_audioForward.y, t, 0.1);
            audioCtx.listener.forwardZ.setTargetAtTime(_audioForward.z, t, 0.1);
            audioCtx.listener.upX.setTargetAtTime(_audioUp.x, t, 0.1);
            audioCtx.listener.upY.setTargetAtTime(_audioUp.y, t, 0.1);
            audioCtx.listener.upZ.setTargetAtTime(_audioUp.z, t, 0.1);
        }

        let insideCloud = false;
        const camPos = me.camera.position;

        // InstancedMesh.raycast walks every cloud whenever the camera is
        // near just one of them. First apply the same broad-phase distance
        // check per instance, then run the unchanged winding test against
        // only those candidates. The test geometry and matrices are shared
        // with the rendered clouds, so the whiteout boundary is identical.
        _raycaster.set(camPos, _rayDirUp);
        let windingNumber = 0;
        const rayDir = _raycaster.ray.direction;
        for (let i = 0; i < cloudsData.length; i++) {
            const c = cloudsData[i];
            const dx = camPos.x - c.x;
            const dy = camPos.y - c.y;
            const dz = camPos.z - c.z;
            if (dx * dx + dy * dy + dz * dz >= G.cloudBaseRadiusSq * c.scale * c.scale * 1.5) continue;

            G.cloudInstancedMesh.getMatrixAt(i, _instanceMatrix);
            G.cloudRaycastMesh.matrixWorld.copy(_instanceMatrix);
            _normalMatrix.getNormalMatrix(_instanceMatrix);
            _cloudIntersections.length = 0;
            _raycaster.intersectObject(G.cloudRaycastMesh, false, _cloudIntersections);

            for (let j = 0; j < _cloudIntersections.length; j++) {
                const hit = _cloudIntersections[j];
                if (!hit.face) continue;

                _tempVec.copy(hit.face.normal).applyMatrix3(_normalMatrix).normalize();
                const dot = rayDir.dot(_tempVec);
                if (dot > 0.0001) {
                    windingNumber -= 1;
                } else if (dot < -0.0001) {
                    windingNumber += 1;
                }
            }
        }
        insideCloud = windingNumber !== 0;
        
        if (insideCloud !== _hudCache.cloudWhiteout) {
            _DOM.cloudWhiteoutStyle.display = insideCloud ? 'block' : 'none';
            _hudCache.cloudWhiteout = insideCloud;
        }

        updateHUD(me);
        updateSharedMuzzleLight();
        me.camera.updateMatrixWorld();

        // Particle instances are written last, once the camera for this frame
        // is final, since their draw order depends on it.
        G.boxParticlePool.commit(me.camera);
        G.sphereParticlePool.commit(me.camera);

        if (G.csm) G.csm.update();

        G.renderer.render(G.scene, me.camera);
        renderBloom(me.camera);
    }
}

function onWindowResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    if (G.renderer) G.renderer.setSize(width, height);
    resizeBloom();

    resizeUI3D();

    const me = G.localPlayer;
    
    if (me) {
        me.camera.aspect = width / height;
        me.camera.updateProjectionMatrix();
        if (G.csm) G.csm.updateFrustums();
    }
}

export { animate, onWindowResize };
