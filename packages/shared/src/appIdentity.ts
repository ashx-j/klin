/**
 * Klin's identity: every name, ID, folder, port, and URL that an operating system, a remote
 * host, or a release feed uses to tell this app apart from T3 Code. Klin installs next to
 * T3 Code on the same machines, so no value here may equal T3 Code's. Upstream's values are
 * in each comment so a merge can tell which side a literal belongs to.
 */

/** Product name: installer, executable, Start menu entry, window titles. Upstream: "T3 Code". */
export const APP_NAME = "Klin";

/** Lowercase token for package, pipe, cache folder, and systemd unit names. Upstream: "t3code". */
export const APP_SLUG = "klin";

/** Application ID and Windows AppUserModelID. Upstream: "com.t3tools.t3code". */
export const APP_ID = "com.ashx.klin";

/** Home folder, under the user's home, for the desktop app and every server. Upstream: ".t3". */
export const APP_HOME_DIR_NAME = ".klin";

/** URL scheme for deep links and the desktop renderer origin. Upstream: "t3code". */
export const APP_URL_SCHEME = "klin";
export const APP_DEV_URL_SCHEME = `${APP_URL_SCHEME}-dev`;

/** The command the desktop app puts on PATH. Upstream: "t3". */
export const CLI_COMMAND_NAME = "klin";

/**
 * Follows the machine name other devices see, in T3 Connect and T3 Code's phone app, so
 * "homeserver (Klin)" sits next to T3 Code's "homeserver". Upstream: none.
 */
export const ENVIRONMENT_LABEL_SUFFIX = ` (${APP_NAME})`;

/**
 * T3 Connect's sign-in service accepts desktop requests only from T3 Code's `t3code://app`
 * origin, so Klin's desktop app hides in-app sign-in and links with `klin connect link` instead.
 * Upstream: true. Widened like PRODUCT_ANALYTICS_ENABLED.
 */
export const DESKTOP_CONNECT_SIGN_IN: boolean = false;

/** First port a server tries. T3 Code scans 200 ports up from 3773, so stay out of that range. */
export const DEFAULT_SERVER_PORT = 4773;

/** GitHub repository that publishes desktop updates and server archives. Upstream: "pingdotgg/t3code". */
export const RELEASE_REPOSITORY = "ashx-j/klin";
export const RELEASES_PAGE_URL = `https://github.com/${RELEASE_REPOSITORY}/releases`;

/**
 * Product analytics go to T3 Code's own PostHog project, so Klin never sends them. The type is
 * widened so the code behind this switch still type-checks as reachable.
 */
export const PRODUCT_ANALYTICS_ENABLED: boolean = false;

/** Matches the URL protocol of the app scheme on any channel, such as `klin:` and `klin-dev:`. */
export const APP_LINK_PROTOCOL = new RegExp(`^${APP_URL_SCHEME}(?:-[a-z]+)?:$`);
