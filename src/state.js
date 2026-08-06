import * as THREE from 'three';

// Mutable state shared across modules. ES module bindings cannot be reassigned
// from an importing module, so every scalar that more than one module writes to
// lives here as a property of G.
export const G = {
    // --- networking / lobby ---
    socket: null,
    isHost: false,
    myRoomCode: "",
    myUsername: "PILOT",
    myPlayerIndex: -1,
    gameActive: false,
    lastGameStateTime: 0,
    hasConnectedOnce: false,
    isGeneratingWorld: false,
    isQuitting: false,
    pendingJoinCode: null,

    // --- rendering ---
    scene: null,
    renderer: null,
    csm: null,
    // Parent for pooled projectile meshes; see attachPooled().
    pooledRoot: null,

    // --- world ---
    shoreTexture: null,
    shoreRangeUnits: 60,
    shoreDistRangeUnits: 320,
    cloudInstancedMesh: null,
    cloudRaycastMesh: null,
    cloudBaseRadiusSq: 0,
    cloudMaxOriginRadiusSq: 0,
    treeGridDim: 0,
    sharedMuzzleLight: null,
    sharedMuzzleLightOwner: null,

    // --- simulation ---
    localPlayer: null,
    boxParticlePool: null,
    sphereParticlePool: null,

    // --- opening cinematic ---
    introCinematicActive: false,
    introCinematicTime: 0,
    introWireframeMesh: null,
    initialWireframeQuat: new THREE.Quaternion()
};

export const targetWireframeQuat = new THREE.Quaternion(0, 0, 0, 1);

// Collections are only ever mutated in place, so they can be plain const
// bindings rather than properties of G.
export const players = [];
export const netPlayers = [];
export const explosions = [];
export const waterMeshes = [];
export const cloudsData = [];
export const treeGridArr = [];
