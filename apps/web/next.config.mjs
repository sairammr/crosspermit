/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,

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
