import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import {
    BLOOM_LAYER, CONFIG, MAX_PLANE_AMMO, TREE_GRID_SIZE,
    acceleration, stallSpeed, turnSpeed
} from './config.js';
import { G, players, explosions, treeGridArr } from './state.js';
import { _tempVec } from './scratch.js';
import { EngineSound, SoundGen } from './audio.js';
import { bakePartGeometry, bakedAnchorPosition } from './geometry-utils.js';
import { getTerrainCellCeiling, getVisualTerrainHeight } from './terrain.js';
import { claimMuzzleLight } from './muzzle-light.js';
import { Explosion } from './particles.js';
import { PlaneWreck } from './wreck.js';
import { getProjectile } from './projectile.js';

class Player {
    constructor(config, isLocal) {
        this.index = config.index;
        this.socketId = config.id;
        this.name = config.name;
        this.isLocal = isLocal;
        this.isAI = !!config.isAI;
        this.isSpawned = this.isAI ? true : false;
        this.disconnected = false;

        const planePalette = [
            0xFF0000, 0x00FF00, 0xFFFF00, 0xFF00FF, 0xFF8C00,
            0xFFFFFF, 0x7CFC00, 0xDC143C, 0xFF1493, 0xFF4500
        ];
        this.color = new THREE.Color(planePalette[this.index % planePalette.length]);

        this.speed = 1.0875;
        this.throttle = 0.5;
        this.hp = 100;
        this.isCrashed = false;
        this.trailParticles = [];
        this.lastShot = 0;
        
        this.maxAmmo = MAX_PLANE_AMMO;
        this.currentAmmo = this.maxAmmo;
        this.reloadTime = 15000; 
        this.isReloading = false;
        this.reloadTimerStart = 0;

        this.isStalled = false;
        this.flashTimer = 0;
        this.isShooting = false;
        this.isFiring = false;
        this.hasInitialSnap = false;

        this.kills = 0;
        this.deaths = 0;
        this.lastAttackerName = null;
        this.diedByCollision = false;
        this.lastRespawnTime = 0;
        this.positionBuffer = [];
        this.respawnTimer = 0;

        this.smoothedPitch = 0;
        this.smoothedRoll = 0;
        this.smoothedYaw = 0;
        this.yawVelocity = 0;
        this.virtualChasePos = null;

        this.inputs = {
            pitch: 0, roll: 0, yaw: 0, throttle: 0, shoot: false, reset: false
        };

        this.engineSound = new EngineSound(isLocal);
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 5.0, 150000);
        this.mesh = this.createPlaneMesh(this.color);

        if (this.isLocal || this.isAI) {
            const safePos = window.getSafeSpawn(1000, 3000);
            this.mesh.position.set(safePos.x, safePos.y, safePos.z);
            this.mesh.lookAt(0, safePos.y, 0);
        } else {
            this.mesh.position.set(0, 1500, 0);
        }

        G.scene.add(this.mesh);

        this.radarBlip = document.createElement('div');
        this.radarBlip.className = 'radar-blip';
        this.radarBlipStyle = this.radarBlip.style;
        this._blipVisible = null;
        const radarColor = '#' + this.color.getHexString();
        this.radarBlipStyle.backgroundColor = radarColor;
        this.radarBlipStyle.boxShadow = `0 0 5px ${radarColor}`;
        if (this.index !== G.myPlayerIndex) {
            document.getElementById('radar').appendChild(this.radarBlip);
        }
    }
    
    dispose() {
        this.disconnected = true;
        this.mesh.visible = false;
        claimMuzzleLight(this, 0);
        if (this.radarBlip && this.radarBlip.parentNode) {
            this.radarBlip.parentNode.removeChild(this.radarBlip);
        }
        if (this.engineSound) {
            this.engineSound.stop();
        }
    }

    createPlaneMesh(color) {
        const planeGroup = new THREE.Group();
        const fuselageColor = 0x8899aa;

        const bodyMat = new THREE.MeshStandardMaterial({
            color: fuselageColor, roughness: 0.4, metalness: 0.6, flatShading: true
        });
        const highlightMat = new THREE.MeshStandardMaterial({
            color: color, roughness: 0.5, metalness: 0.2, flatShading: true
        });
        
        const glassMat = new THREE.MeshStandardMaterial({
            color: 0x080809, metalness: 0.9, roughness: 0.05, transparent: true, opacity: 0.55, flatShading: true
        });

        // Held so the wreckage can be built out of this plane's own materials
        // instead of allocating a matching set every time someone goes down.
        this.bodyMat = bodyMat;
        this.highlightMat = highlightMat;
        this.glassMat = glassMat;

        // Every part below is the same shape, in the same place, with the same
        // material as before. The only change is that parts sharing a material
        // have their transform baked into the geometry and are merged into one
        // mesh. A plane goes from 17 draw calls to 6 - and because planes cast
        // shadows, each of those is submitted again for all three cascades.
        const bodyGeo = new THREE.CylinderGeometry(1.1, 0.9, 7, 10);
        bodyGeo.rotateX(Math.PI / 2);

        const noseGeo = new THREE.CylinderGeometry(0.9, 0.8, 3.5, 10);
        noseGeo.rotateX(Math.PI / 2);
        noseGeo.translate(0, 0, -5.25);

        const spinnerGeo = new THREE.CylinderGeometry(0.8, 0.1, 2, 10);
        spinnerGeo.rotateX(Math.PI / 2);
        spinnerGeo.translate(0, 0, -8);

        const tailBoomGeo = new THREE.CylinderGeometry(0.4, 1.1, 6, 10);
        tailBoomGeo.rotateX(Math.PI / 2);
        tailBoomGeo.translate(0, 0, 6.5);

        const cockpitGeo = new THREE.SphereGeometry(1.1, 8, 8);
        cockpitGeo.scale(1, 0.8, 2.5);
        cockpitGeo.translate(0, 0.8, -0.5);

        const wGeo = new THREE.BoxGeometry(7, 0.2, 3);
        wGeo.translate(3.5, 0, 0.5);

        const wTipGeo = new THREE.BoxGeometry(0.5, 0.21, 3);
        wTipGeo.translate(7.25, 0, 0.5);

        const hStabGeo = new THREE.BoxGeometry(5, 0.15, 2);
        hStabGeo.translate(0, 0, 1);

        const vStabGeo = new THREE.BoxGeometry(0.2, 3, 2.5);
        const pos = vStabGeo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            if (pos.getY(i) > 0) pos.setZ(i, pos.getZ(i) + 1.5);
        }
        vStabGeo.computeVertexNormals();

        const scoopGeo = new THREE.BoxGeometry(1.2, 0.6, 3);
        scoopGeo.translate(0, -0.3, 0);

        const bodyMesh = new THREE.Mesh(BufferGeometryUtils.mergeGeometries([
            bakePartGeometry(bodyGeo,     0, 0, 0,        0, 0, 0,      1, 1, 1),
            bakePartGeometry(noseGeo,     0, 0, 0,        0, 0, 0,      1, 1, 1),
            bakePartGeometry(tailBoomGeo, 0, 0, 0,        0, 0, 0,      1, 1, 1),
            bakePartGeometry(wGeo,        0.8, -0.2, -1,  -0.05, -0.2, 0,  1, 1, 1),
            bakePartGeometry(wGeo,       -0.8, -0.2, -1,  -0.05,  0.2, 0, -1, 1, 1),
            bakePartGeometry(hStabGeo,    0, 0.28, 8.5,   0, 0, 0,      1, 1, 1),
            bakePartGeometry(scoopGeo,    0, -0.9, 1,     0, 0, 0,      1, 1, 1)
        ]), bodyMat);
        planeGroup.add(bodyMesh);

        const highlightMesh = new THREE.Mesh(BufferGeometryUtils.mergeGeometries([
            bakePartGeometry(spinnerGeo,  0, 0, 0,        0, 0, 0,      1, 1, 1),
            bakePartGeometry(wTipGeo,     0.8, -0.2, -1,  -0.05, -0.2, 0,  1, 1, 1),
            bakePartGeometry(wTipGeo,    -0.8, -0.2, -1,  -0.05,  0.2, 0, -1, 1, 1),
            bakePartGeometry(vStabGeo,    0, 2.0, 8.5,    0, 0, 0,      1, 1, 1)
        ]), highlightMat);
        planeGroup.add(highlightMesh);

        const cockpit = new THREE.Mesh(cockpitGeo, glassMat);
        planeGroup.add(cockpit);

        // The wing tips these hang off are merged away, so the anchors carry
        // the baked transform and sit directly on the plane instead.
        this.leftAnchor = new THREE.Object3D();
        bakedAnchorPosition(this.leftAnchor, 7.5, 0, 0.5, 0.8, -0.2, -1, -0.05, -0.2, 0, 1, 1, 1);
        planeGroup.add(this.leftAnchor);

        this.rightAnchor = new THREE.Object3D();
        bakedAnchorPosition(this.rightAnchor, 7.5, 0, 0.5, -0.8, -0.2, -1, -0.05, 0.2, 0, -1, 1, 1);
        planeGroup.add(this.rightAnchor);

        this.propeller = new THREE.Group();
        const bladeGeo = new THREE.BoxGeometry(0.18, 3.6, 0.2);
        bladeGeo.translate(0, 1.8, 0);
        const propMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5, flatShading: true });

        const bladeGeos = [];
        for (let i = 0; i < 3; i++) {
            bladeGeos.push(bakePartGeometry(bladeGeo, 0, 0, 0, 0, 0, (i / 3) * Math.PI * 2, 1, 1, 1));
        }
        this.propeller.add(new THREE.Mesh(BufferGeometryUtils.mergeGeometries(bladeGeos), propMat));

        const capGeo = new THREE.ConeGeometry(0.3, 0.5, 8);
        capGeo.rotateX(Math.PI / 2);
        capGeo.translate(0, 0, 0.25);
        const propCap = new THREE.Mesh(capGeo, highlightMat);
        this.propeller.add(propCap);

        this.propeller.position.set(0, 0, -9.1);
        planeGroup.add(this.propeller);

        // Initialize muzzle flash to be permanently visible to avoid active-light-count shader recompilation.
        const flashGeo = new THREE.DodecahedronGeometry(0.8, 0);
        const flashMat = new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.0, depthWrite: false, fog: false, toneMapped: false });
        this.muzzleFlash = new THREE.Mesh(flashGeo, flashMat);
        this.muzzleFlash.layers.enable(BLOOM_LAYER);
        this.muzzleFlash.position.set(0, 0, -10.5);

        // The point light itself is shared scene-wide; see claimMuzzleLight().
        this.muzzleFlashIntensity = 0;

        this.muzzleFlash.visible = true;
        planeGroup.add(this.muzzleFlash);

        planeGroup.traverse(child => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });

        return planeGroup;
    }

    createTrail(color = 0xdddddd, size = 0.5, opacity = 0.4, offset = new THREE.Vector3(0, 0, 6.5), isFlame = false) {
        const mesh = G.sphereParticlePool.get();
        if (!mesh) return;
        
        mesh.material.color.setHex(color);
        mesh.material.opacity = opacity;
        mesh.scale.setScalar(size);
        
        _tempVec.copy(offset).applyMatrix4(this.mesh.matrixWorld);
        mesh.position.copy(_tempVec);
        
        if (isFlame) {
            mesh.userData.velocity.set((Math.random() - 0.5)*1.5, (Math.random() - 0.5)*1.5, (Math.random() - 0.5)*1.5).multiplyScalar(0.5);
        } else {
            mesh.userData.velocity.set((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).multiplyScalar(0.2);
        }
        
        mesh.userData.life = 1.0;
        mesh.userData.baseOpacity = opacity;
        mesh.userData.isFlame = isFlame;
        mesh.userData.isWater = false;
        // Engine fire glows; smoke and contrails do not.
        mesh.userData.bloom = isFlame ? 0.9 : 0.0;
        mesh.visible = true;
        this.trailParticles.push(mesh);
    }

    createVortex(opacity = 0.3) {
        if (!this.leftAnchor || !this.rightAnchor) return;
        
        const meshL = G.sphereParticlePool.get();
        if (meshL) {
            meshL.material.color.setHex(0xffffff);
            meshL.material.opacity = opacity;
            meshL.scale.setScalar(0.35);
            _tempVec.setFromMatrixPosition(this.leftAnchor.matrixWorld);
            meshL.position.copy(_tempVec);
            meshL.userData.velocity.set((Math.random() - 0.5)*0.1, (Math.random() - 0.5)*0.1, (Math.random() - 0.5)*0.1);
            meshL.userData.life = 1.0;
            meshL.userData.baseOpacity = opacity;
            meshL.userData.isFlame = false;
            meshL.userData.isWater = false;
            meshL.userData.bloom = 0.0;
            meshL.visible = true;
            this.trailParticles.push(meshL);
        }

        const meshR = G.sphereParticlePool.get();
        if (meshR) {
            meshR.material.color.setHex(0xffffff);
            meshR.material.opacity = opacity;
            meshR.scale.setScalar(0.35);
            _tempVec.setFromMatrixPosition(this.rightAnchor.matrixWorld);
            meshR.position.copy(_tempVec);
            meshR.userData.velocity.set((Math.random() - 0.5)*0.1, (Math.random() - 0.5)*0.1, (Math.random() - 0.5)*0.1);
            meshR.userData.life = 1.0;
            meshR.userData.baseOpacity = opacity;
            meshR.userData.isFlame = false;
            meshR.userData.isWater = false;
            meshR.userData.bloom = 0.0;
            meshR.visible = true;
            this.trailParticles.push(meshR);
        }
    }

    createWaterSpray(opacity = 0.5) {
        const mesh = G.sphereParticlePool.get();
        if (!mesh) return;
        
        const size = 0.8 + Math.random() * 1.2;
        mesh.material.color.setHex(0xddffff);
        mesh.material.opacity = opacity;
        mesh.scale.setScalar(size);
        
        _tempVec.set(0, 0, 4).applyQuaternion(this.mesh.quaternion);
        mesh.position.copy(this.mesh.position).add(_tempVec);
        mesh.position.y = CONFIG.waterLevel;
        
        _tempVec.set(0, 0, -1).applyQuaternion(this.mesh.quaternion);
        mesh.userData.velocity.set(
            (Math.random() - 0.5) * 1.5,
            1.5 + Math.random() * 2.5, 
            (Math.random() - 0.5) * 1.5
        );
        mesh.userData.velocity.addScaledVector(_tempVec, this.speed * 0.2);
        
        mesh.userData.life = 1.0;
        mesh.userData.baseOpacity = opacity;
        mesh.userData.isFlame = false;
        mesh.userData.isWater = true;
        mesh.userData.bloom = 0.0;
        mesh.visible = true;

        this.trailParticles.push(mesh);
    }

    explode() {
        if (this.isCrashed) return;
        this.isCrashed = true;

        // Captured before speed is zeroed and before the mesh is hidden: the
        // wreckage inherits the aircraft's momentum, so it needs the state the
        // plane was actually flying with on this frame.
        const impactSpeed = this.speed;
        this.mesh.updateMatrixWorld(true);
        explosions.push(new PlaneWreck(this.mesh, impactSpeed, {
            body: this.bodyMat,
            highlight: this.highlightMat,
            glass: this.glassMat
        }));

        this.speed = 0;
        this.mesh.visible = false;
        if (this.radarBlipStyle) this.radarBlipStyle.display = 'none';
        this.engineSound.stop();
        SoundGen.playExplosion(this.mesh.position);
        explosions.push(new Explosion(this.mesh.position, 0xff0000));
        explosions.push(new Explosion(this.mesh.position, 0xffaa00));

        if (this.index === G.myPlayerIndex) {
            const el = document.getElementById('death-reason');
            if (this.diedByCollision) {
                el.innerText = "MID-AIR COLLISION";
            } else if (this.lastAttackerName) {
                el.innerText = `SHOT DOWN BY ${this.lastAttackerName}`;
            } else {
                el.innerText = "YOU CRASHED";
            }
            document.getElementById('crash-msg').style.display = 'block';
        }
    }

    takeDamage(amount, attackerIdx) {
        if (this.isCrashed) return;

        if (this.index === G.myPlayerIndex || this.isAI) {
            this.hp -= amount;
            if (this.hp <= 0) {
                this.hp = 0;
                this.die(attackerIdx);
            }
        }
    }

    die(attackerIdx) {
        if (this.isCrashed) return;
        this.deaths++;
        let killerName = null;
        if (attackerIdx !== null && attackerIdx !== -1) {
            let attacker = null;
            for (let i = 0; i < players.length; i++) {
                if (players[i].index === attackerIdx) { attacker = players[i]; break; }
            }
            if (attacker) killerName = attacker.name;
        }

        this.lastAttackerName = killerName;
        this.explode();

        const deathData = { type: 'PLAYER_DIED', idx: this.index, attackerIdx: attackerIdx };

        if (G.isHost) {
            if (attackerIdx !== null && attackerIdx !== -1) {
                let attacker = null;
                for (let i = 0; i < players.length; i++) {
                    if (players[i].index === attackerIdx) { attacker = players[i]; break; }
                }
                if (attacker && attacker.index !== this.index) attacker.kills++;
            }
            G.socket.emit('host_broadcast', { roomCode: G.myRoomCode, data: deathData });
        } else {
            G.socket.emit('client_send', { roomCode: G.myRoomCode, data: deathData });
        }
    }

    reset() {
        if (this.isLocal || this.isAI) {
            const safePos = window.getSafeSpawn(1000, 3000);
            this.mesh.position.set(safePos.x, safePos.y, safePos.z);
            this.mesh.lookAt(0, safePos.y, 0);
            this.virtualChasePos = null;
        }
        
        this.speed = 1.0875;
        this.throttle = 0.5;
        this.smoothedPitch = 0;
        this.smoothedRoll = 0;
        this.smoothedYaw = 0;
        this.yawVelocity = 0;
        this.hp = 100;
        this.currentAmmo = this.maxAmmo;
        this.isReloading = false;
        this.reloadTimerStart = 0;
        this.isCrashed = false;
        this.lastAttackerName = null;
        this.diedByCollision = false;
        this.mesh.visible = true;
        if (this.radarBlipStyle) this.radarBlipStyle.display = 'block';
        this.engineSound.restart();
        this.positionBuffer = [];
        this.hasInitialSnap = false;
        this.lastRespawnTime = Date.now();
        this.respawnTimer = 0;
        this.flashTimer = 0;
        if (this.muzzleFlash) {
            this.muzzleFlash.material.opacity = 0;
            claimMuzzleLight(this, 0);
        }

        if (this.index === G.myPlayerIndex) document.getElementById('crash-msg').style.display = 'none';
    }

    updatePhysics(timeScale) {
        if (this.isCrashed) {
            this.respawnTimer += (0.016 * timeScale);
            if (this.respawnTimer > 3.0) this.reset();
            return;
        }

        let effPitch = this.inputs.pitch;
        let effRoll = this.inputs.roll;
        let effYaw = this.inputs.yaw;
        let effThrottle = this.inputs.throttle;
        let effShoot = this.inputs.shoot;

        if (this.isLocal && G.introCinematicActive) {
            effPitch = 0;
            effRoll = 0;
            effYaw = 0;
            effThrottle = 0;
            effShoot = false;
        }

        if (effThrottle === 1) this.throttle += 0.01 * timeScale;
        if (effThrottle === -1) this.throttle -= 0.01 * timeScale;
        this.throttle = Math.max(0, Math.min(1, this.throttle));

        const thrust = this.throttle * acceleration * 1.45 * timeScale;
        this.speed += thrust;

        _tempVec.set(0, 0, -1).applyQuaternion(this.mesh.quaternion);
        const pitchFactor = _tempVec.y;
        this.speed -= pitchFactor * 0.01 * timeScale;

        const parasiticDrag = (this.speed * this.speed) * 0.0028 * timeScale;
        this.speed -= parasiticDrag;

        const maneuveringDrag = (Math.abs(this.smoothedPitch) * 0.005 + Math.abs(this.smoothedRoll) * 0.002 + Math.abs(this.smoothedYaw) * 0.002) * timeScale;
        this.speed -= maneuveringDrag;

        this.speed = Math.max(0.1, this.speed);

        if (this.speed < stallSpeed) {
            this.isStalled = true;
            const severity = 1.0 - (this.speed / stallSpeed);
            this.mesh.position.y -= 0.6 * severity * timeScale;
            this.mesh.rotateX(-0.01 * severity * timeScale);
        } else {
            this.isStalled = false;
        }

        const lerpAlpha = 1.0 - Math.pow(0.88, timeScale);
        this.smoothedPitch = THREE.MathUtils.lerp(this.smoothedPitch, effPitch, lerpAlpha);
        this.smoothedRoll = THREE.MathUtils.lerp(this.smoothedRoll, effRoll, lerpAlpha);
        // Yaw runs through an underdamped spring instead of a plain lerp so the
        // nose overshoots slightly and settles back when rudder is applied and
        // released - the transient sway a real tail gives you.
        const yawStiffness = 0.06;
        const yawDamping = 0.25;
        this.yawVelocity += ((effYaw - this.smoothedYaw) * yawStiffness - this.yawVelocity * yawDamping) * timeScale;
        this.smoothedYaw += this.yawVelocity * timeScale;

        let effectiveTurnSpeed = this.isStalled ? turnSpeed * 0.4 : turnSpeed;
        const scaledTurn = effectiveTurnSpeed * timeScale;

        if (Math.abs(this.smoothedPitch) > 0.001) this.mesh.rotateX(this.smoothedPitch * scaledTurn);
        if (Math.abs(this.smoothedRoll) > 0.001) this.mesh.rotateZ(this.smoothedRoll * scaledTurn * 6.0);
        if (Math.abs(this.smoothedYaw) > 0.001 || Math.abs(this.yawVelocity) > 0.0005) {
            // Rudder alone barely turns a plane - most of the yaw authority
            // real rudders have goes into a sideslip, not heading change.
            this.mesh.rotateY(this.smoothedYaw * scaledTurn * 0.15);
            // The nose swings but momentum carries the plane straight on, so it
            // skids to the outside of the yaw. The velocity term only bites
            // while the rudder is loading up or unloading, so the sway shows up
            // on input and release, not while it is held steady.
            this.mesh.translateX((this.smoothedYaw * 0.06 + this.yawVelocity * 1.2) * timeScale);
        }

        this.mesh.translateZ(-this.speed * timeScale);

        const now = Date.now();
        
        if (this.isReloading) {
            if (now - this.reloadTimerStart >= this.reloadTime) {
                this.isReloading = false;
                this.currentAmmo = this.maxAmmo;
            }
        }

        this.isFiring = (!this.isReloading && effShoot);

        if (this.isFiring && now - this.lastShot > 80) {
            this.lastShot = now;
            this.currentAmmo--;
            if (this.currentAmmo <= 0) {
                this.isReloading = true;
                this.reloadTimerStart = now;
            }

            _tempVec.set(0, 0, -4).applyMatrix4(this.mesh.matrixWorld);
            const p = getProjectile();
            if (p) {
                p.activate(this.index, _tempVec, this.mesh.quaternion, this.speed, this.isLocal || (G.isHost && this.isAI));
                this.flashTimer = 0.1;
                if (this.muzzleFlash) {
                    this.muzzleFlash.material.opacity = 0.8;
                    claimMuzzleLight(this, 150);
                    this.muzzleFlash.rotation.z = Math.random() * Math.PI;
                }
                SoundGen.playShoot(this.mesh.position);
            }
        }

        let hitEnvironment = false;

        if (this.mesh.position.y < CONFIG.waterLevel - 5) {
            hitEnvironment = true;
        } else if (this.mesh.position.y < getTerrainCellCeiling(this.mesh.position.x, this.mesh.position.z)) {
            // Only worth resolving the exact ground height when the plane is
            // low enough for the cell's tallest triangle to reach it.
            const tH = getVisualTerrainHeight(this.mesh.position.x, this.mesh.position.z);
            if (this.mesh.position.y < tH + 2) hitEnvironment = true;
        }

        if (!hitEnvironment && G.treeGridDim > 0) {
            const gx = Math.floor((this.mesh.position.x + CONFIG.width / 2) / TREE_GRID_SIZE);
            const gz = Math.floor((this.mesh.position.z + CONFIG.width / 2) / TREE_GRID_SIZE);

            for (let ox = -1; ox <= 1; ox++) {
                for (let oz = -1; oz <= 1; oz++) {
                    const cx = gx + ox;
                    const cz = gz + oz;
                    if (cx >= 0 && cx < G.treeGridDim && cz >= 0 && cz < G.treeGridDim) {
                        const cell = treeGridArr[cz * G.treeGridDim + cx];
                        for (let j = 0; j < cell.length; j++) {
                            const t = cell[j];
                            if (this.mesh.position.y < t.y + t.h && this.mesh.position.y > t.y) {
                                const dx = this.mesh.position.x - t.x;
                                const dz = this.mesh.position.z - t.z;
                                if (dx * dx + dz * dz < t.rSq) {
                                    hitEnvironment = true;
                                    break;
                                }
                            }
                        }
                    }
                    if (hitEnvironment) break;
                }
                if (hitEnvironment) break;
            }
        }

        if (hitEnvironment) this.takeDamage(100, -1);
    }

    syncData(data) {
        if (!G.isHost) {
            this.kills = data.k || 0;
            this.deaths = data.d || 0;
        }

        if (data.spawned !== undefined) {
            this.isSpawned = data.spawned;
        }

        if (this.index === G.myPlayerIndex) return;

        if (data.crashed && !this.isCrashed) {
            this.lastAttackerName = data.killer;
            this.explode();
        }
        if (!data.crashed && this.isCrashed) this.reset();

        this.hp = data.hp;

        if (data.pos && data.quat) {
            let rTime = Date.now();
            if (this.positionBuffer.length > 0) {
                const lastT = this.positionBuffer[this.positionBuffer.length - 1].timestamp;
                if (rTime <= lastT) {
                    rTime = lastT + 1;
                }
            }

            let bufferItem;
            if (this.positionBuffer.length >= 20) {
                bufferItem = this.positionBuffer.shift();
                bufferItem.timestamp = rTime;
                bufferItem.pos.set(data.pos.x, data.pos.y, data.pos.z);
                bufferItem.quat.set(
                    data.quat.x !== undefined ? data.quat.x : data.quat._x,
                    data.quat.y !== undefined ? data.quat.y : data.quat._y,
                    data.quat.z !== undefined ? data.quat.z : data.quat._z,
                    data.quat.w !== undefined ? data.quat.w : data.quat._w
                );
                bufferItem.spd = data.spd;
                bufferItem.throt = data.throt;
                bufferItem.shoot = data.shoot;
            } else {
                bufferItem = {
                    timestamp: rTime,
                    pos: new THREE.Vector3(data.pos.x, data.pos.y, data.pos.z),
                    quat: new THREE.Quaternion(
                        data.quat.x !== undefined ? data.quat.x : data.quat._x,
                        data.quat.y !== undefined ? data.quat.y : data.quat._y,
                        data.quat.z !== undefined ? data.quat.z : data.quat._z,
                        data.quat.w !== undefined ? data.quat.w : data.quat._w
                    ),
                    spd: data.spd, throt: data.throt, shoot: data.shoot
                };
            }
            this.positionBuffer.push(bufferItem);
        }
    }

    interpolatePosition() {
        if (this.isCrashed) return;

        const renderTimestamp = Date.now() - 75;

        if (this.positionBuffer.length === 0) {
            this.isShooting = false;
            return;
        }

        while (this.positionBuffer.length >= 2 && this.positionBuffer[1].timestamp <= renderTimestamp) {
            this.positionBuffer.shift();
        }

        if (this.positionBuffer.length >= 2) {
            if (this.positionBuffer[0].timestamp <= renderTimestamp && this.positionBuffer[1].timestamp >= renderTimestamp) {
                const prev = this.positionBuffer[0];
                const next = this.positionBuffer[1];

                const totalTime = next.timestamp - prev.timestamp;
                const currentTime = renderTimestamp - prev.timestamp;
                
                let alpha = 0;
                if (totalTime > 0) {
                    alpha = currentTime / totalTime;
                } else {
                    alpha = 1.0;
                }

                this.mesh.position.lerpVectors(prev.pos, next.pos, alpha);
                this.mesh.quaternion.slerpQuaternions(prev.quat, next.quat, alpha);

                this.speed = THREE.MathUtils.lerp(prev.spd, next.spd, alpha);
                this.throttle = THREE.MathUtils.lerp(prev.throt, next.throt, alpha);

                this.isShooting = next.shoot;
                this.hasInitialSnap = true;
            }
        } else if (this.positionBuffer.length === 1) {
            const snap = this.positionBuffer[0];
            if (!this.hasInitialSnap) {
                this.mesh.position.copy(snap.pos);
                this.mesh.quaternion.copy(snap.quat);
                this.isShooting = snap.shoot;
                this.hasInitialSnap = true;
            } else {
                this.isShooting = snap.shoot;
                if (renderTimestamp - snap.timestamp > 150) {
                    this.isShooting = false;
                }
            }
        }
    }

    updateVisuals(timeScale) {
        if (!this.isLocal) {
            if (!this.isSpawned) {
                this.mesh.visible = false;
                this.engineSound.stop();
                return; 
            } else {
                this.mesh.visible = !this.isCrashed;
            }

            if (this.isShooting && !this.isCrashed) {
                const now = Date.now();
                if (now - this.lastShot > 80) {
                    this.lastShot = now;
                    SoundGen.playShoot(this.mesh.position);
                    this.flashTimer = 0.1;
                    if (this.muzzleFlash) {
                        this.muzzleFlash.material.opacity = 0.8;
                        claimMuzzleLight(this, 150);
                        this.muzzleFlash.rotation.z = Math.random() * Math.PI;
                    }
                    _tempVec.set(0, 0, -4).applyMatrix4(this.mesh.matrixWorld);
                    const p = getProjectile();
                    if (p) {
                        p.activate(this.index, _tempVec, this.mesh.quaternion, this.speed, false);
                    }
                }
            }
        }

        if (this.flashTimer > 0) {
            this.flashTimer -= (0.016 * timeScale);
            if (this.flashTimer <= 0) {
                this.flashTimer = 0;
                if (this.muzzleFlash) {
                    this.muzzleFlash.material.opacity = 0;
                    claimMuzzleLight(this, 0);
                }
            } else if (this.muzzleFlash) {
                this.muzzleFlash.material.opacity = 0.8;
                claimMuzzleLight(this, 150);
            }
        }

        if (this.propeller && !this.isCrashed) this.propeller.rotation.z += (0.3 + (this.speed * 0.5)) * timeScale;

        if (!this.isCrashed) {
            this.engineSound.update(this.speed, this.throttle, this.mesh.position);
        } else {
            this.engineSound.stop();
        }

        if (!this.isCrashed && this.speed > 0.5) {
            if (this.hp <= 75) {
                if (Math.random() > 0.4) {
                    _tempVec.set(3.5, 0, 0.5);
                    this.createTrail(0xcccccc, 0.4, 0.5, _tempVec);
                    this.createTrail(0xeeeeee, 0.3, 0.3, _tempVec);
                }
            } 
            if (this.hp <= 50 && this.hp > 25) {
                if (Math.random() > 0.2) {
                    _tempVec.set(0, 0, 6.5);
                    this.createTrail(0x444444, 0.8, 0.7, _tempVec);
                }
            } else if (this.hp <= 25) {
                _tempVec.set(0, 0, 6.5);
                if (Math.random() > 0.1) {
                    this.createTrail(0x111111, 1.0, 0.9, _tempVec);
                }
                if (Math.random() > 0.6) {
                    this.createTrail(0xff6600, 0.5, 0.8, _tempVec, true);
                }
            }
        }

        if (!this.isCrashed && this.speed > 0.8) {
            const gIntensity = Math.abs(this.smoothedPitch) * 1.5 + Math.abs(this.smoothedRoll) * 1.0;
            if (gIntensity > 0.6) {
                const vortexOpacity = Math.min(0.6, (gIntensity - 0.6) * 0.4);
                this.createVortex(vortexOpacity);
            }
        }

        if (!this.isCrashed && this.speed > 0.6) {
            const heightOverWater = this.mesh.position.y - CONFIG.waterLevel;
            if (heightOverWater < 12 && heightOverWater > -5) {
                const tH = getVisualTerrainHeight(this.mesh.position.x, this.mesh.position.z);
                if (tH <= CONFIG.waterLevel + 1) {
                    const intensity = Math.max(0, 1.0 - (heightOverWater / 12));
                    const particleCount = Math.floor(intensity * 3) + 1;
                    for (let k = 0; k < particleCount; k++) {
                        this.createWaterSpray(intensity * 0.6);
                    }
                }
            }
        }

        for (let i = this.trailParticles.length - 1; i >= 0; i--) {
            const p = this.trailParticles[i];
            
            if (p.userData.isFlame) {
                p.userData.life -= 0.06 * timeScale;
                p.scale.multiplyScalar(1.0 - (0.05 * timeScale)); 
            } else {
                p.userData.life -= 0.02 * timeScale;
                if (p.userData.isWater) {
                    p.userData.velocity.y -= 0.15 * timeScale; 
                    p.scale.multiplyScalar(1.0 + (0.015 * timeScale));
                } else {
                    p.scale.multiplyScalar(1.0 + (0.05 * timeScale));
                }
            }

            p.position.addScaledVector(p.userData.velocity, timeScale);
            p.material.opacity = p.userData.life * p.userData.baseOpacity;
            
            if (p.userData.life <= 0) {
                G.sphereParticlePool.release(p);
                this.trailParticles[i] = this.trailParticles[this.trailParticles.length - 1];
                this.trailParticles.pop();
            }
        }
    }
}

export { Player };
