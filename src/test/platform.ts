// SPDX-License-Identifier: MIT
/** The platform the test run started on, put back by {@link restorePlatform}. */
const originalPlatform = navigator.platform;

/** Make `navigator.platform` read `value`, as a test for another OS needs. */
export function setPlatform(value: string): void {
  Object.defineProperty(navigator, "platform", { value, configurable: true, writable: true });
}

/** Put `navigator.platform` back: call it from an `afterEach`. */
export function restorePlatform(): void {
  setPlatform(originalPlatform);
}
