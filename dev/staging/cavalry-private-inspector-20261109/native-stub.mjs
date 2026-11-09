export const system={currentTick:50};export const world=new Proxy({},{get(){throw Error("unexpected global native world read");}});
