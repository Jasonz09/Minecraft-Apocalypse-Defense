import { ScriptEventSource, world } from "@minecraft/server";

/**
 * @typedef {import("@minecraft/server").Player} Player
 * @typedef {import("@minecraft/server").ScriptEventCommandMessageAfterEvent} ScriptEvent
 */

/**
 * Send a readout back to whoever asked for it. A player who typed the command sees it in
 * their own chat; a command block or the server console broadcasts it instead, because
 * there is nobody to answer.
 *
 * Argument parsing lives in ./args.js so it stays testable without the runtime.
 *
 * @param {string[]} lines
 * @param {ScriptEvent} event
 */
export function reply(lines, event) {
    // Bedrock concatenates string[] as raw message fragments; it does not insert line breaks.
    const message = lines.join("\n");
    const initiator = event.initiator;
    if (event.sourceType === ScriptEventSource.Entity && initiator !== undefined && initiator.typeId === "minecraft:player") {
        const player = /** @type {Player} */ (initiator);
        player.sendMessage(message);
        return;
    }
    world.sendMessage(message);
}
