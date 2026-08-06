import { G } from './state.js';
import { _tempVec } from './scratch.js';

// ---- SHARED MUZZLE FLASH LIGHT ----
// Each plane used to own a PointLight that stayed in the scene permanently
// (held at intensity 0) so the active-light count never changed and no shader
// recompile could stutter mid-fight. The cost of that is real: NUM_POINT_LIGHTS
// equals the player count, and every one of them runs a full BRDF evaluation
// on every shaded fragment of terrain, trees, water and planes - lit or not.
//
// One scene-level light replaces all of them. The count is pinned at 1 forever,
// so the recompile hazard is still gone, while the per-fragment cost stops
// scaling with the lobby size. The light has a 40-unit radius, so in practice
// it only ever illuminates the plane holding it. The local plane always wins
// the claim, because that is the one filling the screen.

function claimMuzzleLight(player, intensity) {
    player.muzzleFlashIntensity = intensity;
    if (intensity > 0) {
        const cur = G.sharedMuzzleLightOwner;
        if (!cur || cur === player || cur.muzzleFlashIntensity <= 0 ||
            (player.isLocal && !cur.isLocal)) {
            G.sharedMuzzleLightOwner = player;
        }
    } else if (G.sharedMuzzleLightOwner === player) {
        G.sharedMuzzleLightOwner = null;
    }
}

function updateSharedMuzzleLight() {
    if (!G.sharedMuzzleLight) return;
    const owner = G.sharedMuzzleLightOwner;
    // A per-plane light attached to a hidden plane contributed nothing, because
    // the renderer skips invisible subtrees when it collects lights. Reproduce
    // that here so a crashed or unspawned owner cannot leave the light burning.
    if (!owner || owner.muzzleFlashIntensity <= 0 || owner.disconnected || !owner.mesh.visible) {
        G.sharedMuzzleLight.intensity = 0;
        return;
    }
    G.sharedMuzzleLight.intensity = owner.muzzleFlashIntensity;
    owner.mesh.updateMatrixWorld();
    // Matches the old light's place in the hierarchy: the muzzle flash mesh
    // sits at (0, 0, -10.5) in plane space and the light sat at its origin.
    _tempVec.set(0, 0, -10.5).applyMatrix4(owner.mesh.matrixWorld);
    G.sharedMuzzleLight.position.copy(_tempVec);
}

export { claimMuzzleLight, updateSharedMuzzleLight };
