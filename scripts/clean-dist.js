const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
const targetDir = path.resolve(repoRoot, 'dist')

// Safety validation: ensure targetDir strictly equals <repoRoot>/dist
if (targetDir !== path.join(repoRoot, 'dist')) {
    console.error(`Safety check failed: target directory ${targetDir} does not match expected dist directory`)
    process.exit(1)
}

if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true })
    console.log(`Cleaned directory: ${targetDir}`)
}
