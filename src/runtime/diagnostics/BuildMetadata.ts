import fs from 'fs'
import path from 'path'

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

    const normalizedDir = __dirname.replace(/\\/g, '/')
    const isDist = normalizedDir.includes('/dist') || __filename.replace(/\\/g, '/').includes('/dist')
    const entrypoint: 'src' | 'dist' = isDist ? 'dist' : 'src'

    let commit = 'source'
    let builtAt = new Date().toISOString()

    if (entrypoint === 'dist') {
        try {
            const candidates = [
                path.resolve(__dirname, '../../build-info.json'),
                path.resolve(__dirname, '../build-info.json'),
                path.resolve(process.cwd(), 'dist/build-info.json')
            ]
            for (const candidate of candidates) {
                if (fs.existsSync(candidate)) {
                    const raw = fs.readFileSync(candidate, 'utf8')
                    const data = JSON.parse(raw)
                    if (data && typeof data === 'object') {
                        commit = data.commit || 'unknown'
                        builtAt = data.builtAt || builtAt
                        break
                    }
                }
            }
        } catch {
            commit = 'unknown'
        }
        if (commit === 'source') {
            commit = 'unknown'
        }
    } else {
        commit = process.env.GIT_COMMIT || 'source'
    }

    cachedMetadata = { commit, builtAt, entrypoint }
    return cachedMetadata
}

export function resetBuildMetadataCacheForTest(): void {
    cachedMetadata = null
}

export function formatBuildMetadataLog(meta: RuntimeBuildMetadata = resolveBuildMetadata()): string {
    return `[RUNTIME-BUILD] commit=${meta.commit} builtAt=${meta.builtAt} entrypoint=${meta.entrypoint}`
}
