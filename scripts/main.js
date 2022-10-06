const moduleID = 'pf2e-darkness-effects';
const dimLightEffectID = '1JYStHqExNLfpRxl';
const darknessEffectID = 'uxlkHZ3L0VYLRfne';

const logg = x => console.log(x);

const checkLighting = scene => {
    const { tokenVision, globalLight, darkness, globalLightThreshold } = scene;
    const thresholdEnabled = typeof(globalLightThreshold) === 'number';
    if (thresholdEnabled) return darkness > globalLightThreshold;
    return !globalLight || tokenVision;
};


Hooks.once('init', () => {
    game.settings.register(moduleID, 'chatMessageAlert', {
        name: 'Chat Message Alerts',
        scope: 'world',
        config: true,
        type: String,
        choices: {
            off: "Off",
            players: "Players",
            both: "GMs + Players",
            gm: "GMs"
        },
        default: 'off'
    });

    game.settings.register(moduleID, 'dimlyLit', {
        name: '"Dimly Lit" Effect Override Item ID',
        hint: 'Enter the ID of an effect here to use instead of the bundled "Dimly Lit" effect.',
        scope: 'client',
        config: true,
        type: String,
        default: ''
    });

    game.settings.register(moduleID, 'inDarkness', {
        name: '"In Darkness" Effect Override Item ID',
        hint: 'Enter the ID of an effect here to use instead of the bundled "In Darkness" effect.',
        scope: 'client',
        config: true,
        type: String,
        default: ''
    });
});


Hooks.on('updateScene', (sceneDoc, diff, options, userID) => {
    if (game.user.id !== userID) return;
    
    if (sceneDoc === canvas.scene) return updateTokens(); // Viewed scene is scene being updated. Update tokens.
    else { // Other scene is being updated. Prompt user to switch to that scene to update tokens. Required as lighting layer quadtree is used to determine lighting.
        //ui.notifications.info(`Switch to scene (${sceneDoc.name}) to update darkness effects.`);
        const hk = Hooks.on('canvasReady', async newCanvas => {
            if (game.user.id !== userID) return;
            if (newCanvas !== sceneDoc) return;

            await updateTokens();

            Hooks.off('canvasReady', hk);
        });
    }


    async function updateTokens() {
        for (const token of sceneDoc.tokens) await setEffect(token);
    }
});

Hooks.on('createToken', (tokenDoc, options, userID) => {
    if (game.user.id !== userID) return;

    return setEffect(tokenDoc);
});

Hooks.on('updateToken', (tokenDoc, diff, options, userID) => {
    if (!('x' in diff) && !('y' in diff)) return;
    if (game.user.id !== userID) return;

    return setEffect(tokenDoc);
});


async function setEffect(tokenDoc) {
    const scene = tokenDoc.parent;
    if (scene !== canvas.scene) return;

    const { actor } = tokenDoc;

    // If lighting should not be checked in this scene, remove all darkness effects.
    const shouldCheckLighting = checkLighting(scene);
    if (!shouldCheckLighting) {
        const darknessEffectIDs = actor.itemTypes.effect.filter(e => e.flags[moduleID]).map(e => e.id);
        return actor.deleteEmbeddedDocuments('Item', darknessEffectIDs);
    }

    // Use lighting layer quadtree to get light objects that collide with token bounds. While searching, filter out lights if the light's polygon does not contain token center point.
    const { x, y } = tokenDoc.object.getCenter(tokenDoc.x, tokenDoc.y);
    const lightPolygonFilter = (o, rect) => {
        const light = o.t;
        const { los } = light.source;
        const tokenInLightPolygon = los.contains(x, y);
        if (tokenInLightPolygon) {
            // If token is within light polygon, determine if token is within light's bright radius.
            const lightX = light.x;
            const lightY = light.y;
            const a = lightX - x;
            const b = lightY - y;
            const distance = Math.sqrt((a ** 2) + (b ** 2));
            const { brightRadius } = light;
            // Flag the light to be caught later.
            light[moduleID] = {
                brightlyLighting: distance < brightRadius
            };

            return true;
        }

        return false;
    };
    const lights = canvas.lighting.quadtree.getObjects(tokenDoc.bounds, { collisionTest: lightPolygonFilter });

    let effect; // Set assumption that token is brightly lit. Remove all effects and do not create any new ones.
    if (!lights.size) effect = 'darkness'; // No lights found. Assign "In Darkness" effect.
    else if (!lights.some(l => l[moduleID]?.brightlyLighting)) effect = 'dimLight'; // Token is in light, but not within any bright radius. Assign "Dimly Lit" effect.

    // Get target effect from override if present; from compendium if not.
    let targetEffect, override;
    try {
        override = game.settings.get(moduleID, effect);
    } catch (e) { }

    if (override) targetEffect = game.items.get(override);
    else {
        let effectID;
        if (effect) effectID = effect === 'dimLight' ? dimLightEffectID : darknessEffectID;
        const compendium = game.packs.get(`${moduleID}.darkness-effects`);
        targetEffect = await compendium.getDocument(effectID);
    }

    // Check if target effect is already on actor.
    const darknessEffects = actor.itemTypes.effect.filter(e => e.flags[moduleID]);
    if (darknessEffects.some(e => e.name === targetEffect?.name)) return;

    // Remove all pre-existing darkness effects.
    const effectIDs = darknessEffects.map(e => e.id);
    await actor.deleteEmbeddedDocuments('Item', effectIDs);

    // Create effect on actor.
    if (targetEffect) {
        const createData = targetEffect.toObject();
        createData.flags[moduleID] = {
            [effect]: true
        };
        await actor.createEmbeddedDocuments('Item', [createData]);
    }

    // Create chat message if enabled.
    const chatMessageAlertSetting = game.settings.get(moduleID, 'chatMessageAlert');
    if (chatMessageAlertSetting === 'off') return;

    let content = `${tokenDoc.name} enters `;
    if (effect === 'dimLight') content += 'dim light.';
    else if (effect === 'darkness') content += 'darkness.';
    else content += 'bright light.';

    const whisper = [];
    const tokenHidden = tokenDoc.hidden || actor.itemTypes.condition.includes('Concealed') || actor.itemTypes.condition.includes('Hidden');
    if (chatMessageAlertSetting === 'gm' || tokenHidden) whisper.push(...game.users.filter(u => u.isGM).map(u => u.id));
    else if (chatMessageAlertSetting === 'players') whisper.push(...game.users.filter(u => !u.isGM).map(u => u.id));

    await ChatMessage.create({
        content,
        whisper
    });
}
