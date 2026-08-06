import * as THREE from 'three';
import { CONFIG, WORLD_CHUNK_DIM } from './config.js';
import { G } from './state.js';

const _bakeObj = new THREE.Object3D();

// Bakes a part's local transform into a copy of its geometry, so parts that
// share a material can be merged into a single draw call. A mirrored part has
// a negative-determinant matrix; the renderer normally compensates by flipping
// the front face for it at draw time, so once the transform is baked the
// triangle winding has to be reversed by hand to keep the same faces outward.
function bakePartGeometry(geo, px, py, pz, rx, ry, rz, sx, sy, sz) {
    const g = geo.clone();
    _bakeObj.position.set(px, py, pz);
    _bakeObj.rotation.set(rx, ry, rz);
    _bakeObj.scale.set(sx, sy, sz);
    _bakeObj.updateMatrix();
    g.applyMatrix4(_bakeObj.matrix);

    if (_bakeObj.matrix.determinant() < 0) {
        const idx = g.index;
        if (idx) {
            const a = idx.array;
            for (let i = 0; i < a.length; i += 3) {
                const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t;
            }
            idx.needsUpdate = true;
        } else {
            for (const name in g.attributes) {
                const attr = g.attributes[name];
                const arr = attr.array, n = attr.itemSize;
                for (let i = 0; i < attr.count; i += 3) {
                    for (let k = 0; k < n; k++) {
                        const i1 = (i + 1) * n + k, i2 = (i + 2) * n + k;
                        const t = arr[i1]; arr[i1] = arr[i2]; arr[i2] = t;
                    }
                }
                attr.needsUpdate = true;
            }
        }
    }
    return g;
}

// Local-space position of a point that used to be parented to a transformed
// part, for anchors whose parent geometry has been merged away.
function bakedAnchorPosition(target, lx, ly, lz, px, py, pz, rx, ry, rz, sx, sy, sz) {
    _bakeObj.position.set(px, py, pz);
    _bakeObj.rotation.set(rx, ry, rz);
    _bakeObj.scale.set(sx, sy, sz);
    _bakeObj.updateMatrix();
    target.position.set(lx, ly, lz).applyMatrix4(_bakeObj.matrix);
}

// Static scenery never moves once generated, so its local matrix can be
// composed once instead of every frame by the renderer's scene walk.
function freezeTransform(obj) {
    obj.traverse(o => {
        o.updateMatrix();
        o.matrixAutoUpdate = false;
    });
}

// ---- WORLD CHUNKING ----
// The map is 14km across but the camera sees a wedge of it, and cascade 0
// of the sun shadows covers only a few thousand units. As one mesh, the terrain was
// submitted whole for the colour pass and again for each of the three
// cascades - a quarter of a million triangles, four times a frame, however
// little of it was on screen. Splitting it into a grid gives the frustum
// test something to reject.
//
// 8x8 is the balance point: 64 cells of 1750 units cull most of the world
// in a typical view while keeping the worst-case draw call count low enough
// that the per-call overhead stays well under what the culling saves.
// Props use the same grid so a rejected cell rejects its trees with it.


// Triangles are bucketed by centroid and their vertex data copied verbatim
// out of the worker's arrays - no regenerated normals and no reseaming, so
// the surface is identical to the single-mesh version. A triangle may
// overhang its cell by up to the jitter limit; the per-chunk bounding
// sphere is computed from the vertices actually in the chunk, so it covers
// that overhang on its own.
function buildChunkedTerrain(positions, normals, colors, material) {
    const dim = WORLD_CHUNK_DIM;
    const cellSize = CONFIG.width / dim;
    const halfW = CONFIG.width / 2;
    const cellTotal = dim * dim;
    const triCount = (positions.length / 9) | 0;

    const counts = new Uint32Array(cellTotal);
    const cellOf = new Uint16Array(triCount);

    for (let t = 0; t < triCount; t++) {
        const i = t * 9;
        const cx = (positions[i] + positions[i + 3] + positions[i + 6]) / 3;
        const cz = (positions[i + 2] + positions[i + 5] + positions[i + 8]) / 3;
        let gx = Math.floor((cx + halfW) / cellSize);
        let gz = Math.floor((cz + halfW) / cellSize);
        if (gx < 0) gx = 0; else if (gx >= dim) gx = dim - 1;
        if (gz < 0) gz = 0; else if (gz >= dim) gz = dim - 1;
        const cell = gz * dim + gx;
        cellOf[t] = cell;
        counts[cell]++;
    }

    const cellPos = new Array(cellTotal);
    const cellNorm = new Array(cellTotal);
    const cellCol = new Array(cellTotal);
    for (let c = 0; c < cellTotal; c++) {
        if (counts[c] === 0) continue;
        cellPos[c] = new Float32Array(counts[c] * 9);
        cellNorm[c] = new Float32Array(counts[c] * 9);
        cellCol[c] = new Float32Array(counts[c] * 9);
    }

    const cursors = new Uint32Array(cellTotal);
    for (let t = 0; t < triCount; t++) {
        const c = cellOf[t];
        const src = t * 9;
        const dst = cursors[c];
        cursors[c] = dst + 9;
        const dp = cellPos[c], dn = cellNorm[c], dc = cellCol[c];
        for (let k = 0; k < 9; k++) {
            dp[dst + k] = positions[src + k];
            dn[dst + k] = normals[src + k];
            dc[dst + k] = colors[src + k];
        }
    }

    const meshes = [];
    for (let c = 0; c < cellTotal; c++) {
        if (counts[c] === 0) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(cellPos[c], 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(cellNorm[c], 3));
        geo.setAttribute('color', new THREE.BufferAttribute(cellCol[c], 3));
        geo.computeBoundingSphere();

        const mesh = new THREE.Mesh(geo, material);
        mesh.receiveShadow = true;
        mesh.castShadow = true;
        freezeTransform(mesh);
        G.scene.add(mesh);
        meshes.push(mesh);
    }
    return meshes;
}

// ---- POOLED OBJECT ATTACHMENT ----
// The projectile pool allocates its 250 rounds up front and used to keep all
// of them parented to the scene for the entire match. The renderer walks the
// scene graph once for the camera and once per shadow cascade, so every idle
// pooled object is visited four times a frame only to be found invisible.
//
// Pooled meshes now stay detached until they are actually in use. They are
// invisible while detached, so nothing about the rendered image changes.
// Attach/detach is O(1): three.js's own add/remove would do an indexOf over
// the child list, which is exactly the linear cost being removed here.
// (The particle pools solve the same problem by instancing instead - see
// ParticlePool.)

function attachPooled(mesh) {
    if (mesh.parent === G.pooledRoot) return;
    const arr = G.pooledRoot.children;
    mesh.parent = G.pooledRoot;
    mesh.userData.childIdx = arr.length;
    arr.push(mesh);
}

function detachPooled(mesh) {
    if (mesh.parent !== G.pooledRoot) return;
    const arr = G.pooledRoot.children;
    const i = mesh.userData.childIdx;
    if (i < 0 || arr[i] !== mesh) { mesh.parent = null; return; }
    const last = arr[arr.length - 1];
    arr[i] = last;
    last.userData.childIdx = i;
    arr.pop();
    mesh.parent = null;
    mesh.userData.childIdx = -1;
}

export { bakePartGeometry, bakedAnchorPosition, freezeTransform, buildChunkedTerrain, attachPooled, detachPooled };
