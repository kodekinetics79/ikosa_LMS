/**
 * The session cookie name is shared by the proxy gate and the auth module.
 * It is kept in its own dependency-free module so src/proxy.ts does not pull
 * the persistence layer into the pre-render path.
 */
export const SESSION_COOKIE = "ik_session";
