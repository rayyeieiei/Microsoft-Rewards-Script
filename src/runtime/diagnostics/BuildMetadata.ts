import { execSync } from 'child_process'

export interface RuntimeBuildMetadata {
    commit: string
    builtAt: string
    entrypoint: 'src' | 'dist'
}

let cachedMetadata: RuntimeBuildMetadata | null = null

export function resolveBuildMetadata(): RuntimeBuildMetadata {
    if (cachedMetadata) {
        return cachedMetadata
    }

    let commit = process.env.GIT_COMMIT || 'unknown'
    if (commit === 'unknown') {
        try {
            commit = execSync('git rev-parse --short HEAD', {
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 1500
            })
                .toString()
                .trim()
        } catch {
            commit = 'unknown'
        }
    }

    const builtAt = process.env.BUILD_TIMESTAMP || new Date().toISOString()

    const normalizedDir = __dirname.replace(/\\/g, '/')
    const entrypoint: 'src' | 'dist' = normalizedDir.includes('/dist') || __filename.replace(/\\/g, '/').includes('/dist')
        ? 'dist'
        : 'src'

    cachedMetadata = { commit, builtAt, entrypoint }
    return cachedMetadata
}

export function formatBuildMetadataLog(meta: RuntimeBuildMetadata = resolveBuildMetadata()): string {
    return `[RUNTIME-BUILD] commit=${meta.commit} builtAt=${meta.builtAt} entrypoint=${meta.entrypoint}`
}
