// apps/mobile/src/lib/authClientMetadata.ts
// presents native clients in authenticated environment sessions
import type { AuthClientPresentationMetadata } from "@t3tools/contracts";
import * as Device from "expo-device";
import { Platform } from "react-native";

export function authClientMetadata(appVersion?: string): AuthClientPresentationMetadata {
  return {
    label: "456code Mobile",
    deviceType:
      Device.deviceType === Device.DeviceType.TABLET
        ? "tablet"
        : Device.deviceType === Device.DeviceType.PHONE
          ? "mobile"
          : "unknown",
    ...(Platform.OS === "ios" ? { os: "iOS" } : Platform.OS === "android" ? { os: "Android" } : {}),
    surface: "mobile",
    ...(appVersion ? { appVersion } : {}),
  };
}
