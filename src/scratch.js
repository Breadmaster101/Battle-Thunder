import * as THREE from 'three';

// Preallocated scratch objects. Every one of these exists purely to keep the
// per-frame allocation count at zero; none of them carries state between uses.

// Shared Global Math Objects (Drastically reduces GC allocation stuttering)
const _tempVec = new THREE.Vector3();
const _tempDiff = new THREE.Vector3();
const _tempQuat = new THREE.Quaternion();
const _raycaster = new THREE.Raycaster();
const _instanceMatrix = new THREE.Matrix4();
const _normalMatrix = new THREE.Matrix3();
const _rayDirUp = new THREE.Vector3(0, 1, 0);
const _cloudIntersections = [];

// Variables for AI simulation (reused to avoid allocation GC spikes)
const _aiTargetForward = new THREE.Vector3();
const _aiTargetVelocity = new THREE.Vector3();
const _aiFuturePos = new THREE.Vector3();
const _aiDirNorm = new THREE.Vector3();
const _aiWorldUpLocal = new THREE.Vector3();
const _aiForwardVec = new THREE.Vector3();
const _aiCheckPos = new THREE.Vector3();

// Shared variables for render loop to eliminate per-frame allocations
const _cloudDummy = new THREE.Object3D();
const _cineDummyCam = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
const _cineStartOffset = new THREE.Vector3();
const _cineLocalLookAt = new THREE.Vector3();
const _cineEndLookAt = new THREE.Vector3();

// Reused when pushing the camera pose to the audio listener.
const _audioForward = new THREE.Vector3();
const _audioUp = new THREE.Vector3();

export {
    _tempVec, _tempDiff, _tempQuat, _raycaster, _instanceMatrix, _normalMatrix,
    _rayDirUp, _cloudIntersections,
    _aiTargetForward, _aiTargetVelocity, _aiFuturePos, _aiDirNorm, _aiWorldUpLocal,
    _aiForwardVec, _aiCheckPos,
    _cloudDummy, _cineDummyCam, _cineStartOffset, _cineLocalLookAt, _cineEndLookAt,
    _audioForward, _audioUp
};
