const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const repoRoot = path.resolve(__dirname, '..')
const distDir = path.join(repoRoot, 'dist')

let commit = 'unknown'
try {
    commit = execSync('git rev-parse --short HEAD', {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000
    }).toString().trim()
} catch {}

const buildInfo = {
    commit,
    builtAt: new Date().toISOString()
}

if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true })
}

fs.writeFileSync(
    path.join(distDir, 'build-info.json'),
    JSON.stringify(buildInfo, null, 2)
)
console.log(`Generated dist/build-info.json (commit=${commit})`)
