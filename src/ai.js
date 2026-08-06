import { AI_CLOUD_AIM_CONFIDENCE, maxSpeed, stallSpeed } from './config.js';
import { G, players } from './state.js';
import {
    _tempDiff, _tempQuat, _aiTargetForward, _aiTargetVelocity, _aiFuturePos,
    _aiDirNorm, _aiWorldUpLocal, _aiForwardVec, _aiCheckPos
} from './scratch.js';
import { getTerrainHeight } from './terrain.js';
import { isPointInsideCloud } from './scenery.js';

function simulateAI(p, timeScale) {
    if (p.isCrashed) return;
    
    let nearestTarget = null;
    let minDist = Infinity;
    
    for (let i = 0; i < players.length; i++) {
        let other = players[i];
        if (other.index === p.index) continue;
        if (other.isCrashed) continue;
        
        const isTargetSpawned = other.isLocal ? !G.introCinematicActive : other.isSpawned;
        if (!isTargetSpawned) continue;
        if (other.disconnected) continue;
        
        const d = p.mesh.position.distanceTo(other.mesh.position);
        if (d < minDist) {
            minDist = d;
            nearestTarget = other;
        }
    }
    
    let dist = Infinity;
    let localTarget = null;

    if (nearestTarget) {
        const bulletSpeed = p.speed + 15.0; 
        // The nearest-target search already computed this exact distance.
        dist = minDist;
        const timeToHit = dist / bulletSpeed; 
        const aimConfidence = isPointInsideCloud(p.mesh.position) ? AI_CLOUD_AIM_CONFIDENCE : 1.0;
        
        _aiTargetForward.set(0, 0, -1).applyQuaternion(nearestTarget.mesh.quaternion);
        _aiTargetVelocity.copy(_aiTargetForward).multiplyScalar(nearestTarget.speed);
        _aiFuturePos.copy(nearestTarget.mesh.position).addScaledVector(_aiTargetVelocity, timeToHit * aimConfidence);
        
        _tempDiff.subVectors(_aiFuturePos, p.mesh.position);
        _aiDirNorm.copy(_tempDiff).normalize();
        
        _tempQuat.copy(p.mesh.quaternion).invert();
        localTarget = _aiDirNorm.applyQuaternion(_tempQuat);
        
        let targetRoll = 0;
        if (Math.abs(localTarget.x) > 0.01) {
            targetRoll = -localTarget.x * 4.0; 
        }
        p.inputs.roll = Math.max(-1.0, Math.min(1.0, targetRoll));
        
        let targetPitch = localTarget.y * 3.0; 
        if (localTarget.z > 0) {
            targetPitch = 1.0; 
            if (Math.abs(localTarget.x) < 0.2) {
                p.inputs.roll = 1.0; 
            }
        }
        p.inputs.pitch = Math.max(-1.0, Math.min(1.0, targetPitch));
        
        p.inputs.shoot = (
            localTarget.z < 0 &&
            (localTarget.x * localTarget.x + localTarget.y * localTarget.y < 0.08 * aimConfidence) &&
            dist < 800 + 700 * aimConfidence
        );
    } else {
        p.inputs.pitch = 0.0;
        p.inputs.roll = 0.1; 
        p.inputs.shoot = false;
    }
    
    const forwardDist = 450; 
    _aiForwardVec.set(0, 0, -1).applyQuaternion(p.mesh.quaternion);
    _aiCheckPos.copy(p.mesh.position).addScaledVector(_aiForwardVec, forwardDist);
    
    const terrainAhead = getTerrainHeight(_aiCheckPos.x, _aiCheckPos.z);
    const currentTerrain = getTerrainHeight(p.mesh.position.x, p.mesh.position.z);
    const alertHeight = Math.max(terrainAhead, currentTerrain) + 150; 
    
    if (p.mesh.position.y < alertHeight) {
        p.inputs.pitch = 1.0; 
        _tempQuat.copy(p.mesh.quaternion).invert();
        _aiWorldUpLocal.set(0, 1, 0).applyQuaternion(_tempQuat);
        p.inputs.roll = -_aiWorldUpLocal.x * 4.0;
        p.inputs.throttle = 1.0; 
        p.inputs.shoot = false; 
    } else {
        if (p.speed < stallSpeed + 0.4) {
            p.inputs.throttle = 1.0;
        } else if (p.speed > maxSpeed - 0.2) {
            p.inputs.throttle = -1.0;
        } else {
            if (nearestTarget && localTarget && localTarget.z < 0) {
                if (dist > 800) p.inputs.throttle = 1.0; 
                else if (dist < 300) p.inputs.throttle = -1.0; 
                else p.inputs.throttle = 0.0; 
            } else {
                p.inputs.throttle = 0.0;
            }
        }
    }
}

export { simulateAI };
