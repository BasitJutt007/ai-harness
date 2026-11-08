#!/usr/bin/env node
// Test fixture Measure (the suite's fixture contracts name it; test/support/items.ts): prints 0 on any tree.
// The fixture items are proposed with a before value of 1 read by this same script, so a fixture run
// tree reads 0 and the item-metric gate sees the metric move. Not a measure of anything real.
console.log(0);
