// Text-module imports. Wrangler's `Text` rule (see wrangler.jsonc) bundles these
// files as their raw string contents; these ambient declarations give them types.
declare module "*.css" {
  const content: string;
  export default content;
}
declare module "*.client.js" {
  const content: string;
  export default content;
}
// `Data` rule (see wrangler.jsonc): PNGs are bundled as raw bytes.
declare module "*.png" {
  const content: ArrayBuffer;
  export default content;
}
