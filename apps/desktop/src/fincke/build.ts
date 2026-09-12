// The personal desktop build is explicit; upstream unit tests retain their default identity.
declare const __FINCKE_DESKTOP__: boolean;
export const isFinckeDesktop = typeof __FINCKE_DESKTOP__ !== "undefined" && __FINCKE_DESKTOP__;

export const finckeDesktop = {
  name: "456code",
  appId: "com.ggfincke.456code.thin",
  profile: "456code-thin",
  home: ".456code-thin",
  scheme: "code456-thin",
} as const;
