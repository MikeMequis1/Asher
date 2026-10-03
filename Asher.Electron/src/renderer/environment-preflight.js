/**
 * @typedef {object} MissingComponent
 * @property {string} id
 * @property {'runtime' | 'package'} kind
 * @property {string} label
 * @property {string} reason
 * @property {string[]} packages
 */

/**
 * @typedef {object} PreflightResult
 * @property {string} platform
 * @property {boolean} requiresComponents
 * @property {MissingComponent[]} missing
 * @property {boolean} canAutoInstall
 * @property {string | null} packageManager
 */

export {};
