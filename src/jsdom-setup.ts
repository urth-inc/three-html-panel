// Web APIs every supported browser has and jsdom lacks: the agent calls them
// unchecked, so the tests stand in for them. getAnimations is on Node (both
// Document and Element have it), so a test that defines its own on Element or
// on the document and deletes it afterwards falls back to this one.
Object.assign(Node.prototype, { getAnimations: (): Animation[] => [] });
