/** @type {import('next').NextConfig} */
/**
 * Where the desk layer is listening. Server-side only: the browser never learns it, because it never
 * talks to it directly — see the rewrite below.
 */
const DESK_URL = process.env.DESK_URL ?? "http://localhost:8788";

export default {
  reactStrictMode: true,

  /**
   * The desk layer, served from this origin.
   *
   * A proxy rather than a cross-origin fetch, and the reason is the session cookie: the layer sets
   * it `SameSite=Lax`, which a browser will not send on a cross-site request, and `SameSite=None`
   * would demand HTTPS in development. Behind this rewrite the layer is same-origin, so the cookie
   * rides along on an ordinary fetch, there is no CORS to configure, and the layer's own address
   * never reaches the client bundle.
   */
  async rewrites() {
    return [{ source: "/api/desk/:path*", destination: `${DESK_URL}/v1/:path*` }];
  },
  // The SDK is consumed as TypeScript source from the workspace rather than as a build artifact,
  // so Next has to compile it alongside the app.
  transpilePackages: ["@crosspermit/sdk"],

  webpack: (config) => {
    // The SDK writes ESM-correct `./foo.js` specifiers that resolve to `./foo.ts` on disk. Node and
    // bun follow that; webpack needs to be told. Without this the SDK's own internal imports fail
    // even though the package resolves fine.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};
