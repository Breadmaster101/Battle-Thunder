// Helper to yield main thread and allow UI/CSS to unfreeze
export const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 5));
