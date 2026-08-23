import path from "node:path"

type CosmosFixtureManifest = {
  rendererUrl: string
  fixtures: Array<{ filePath: string }>
}

const exportDirectory = path.resolve(import.meta.dir, "../cosmos-export")
const expectedFixtureFiles = [
  "pages/full-am62l-soc-failing-repro.page.tsx",
  "pages/ram-bga.page.tsx",
  "pages/soc-bga.page.tsx",
]
const sourceModulePattern = /(?:^|["'(=/])src\/[^"')?]+\.(?:jsx?|tsx?)/i
const localAssetPattern = /\b(?:src|href)=["']([^"']+)["']/gi

const assertExportFileExists = async (
  filePath: string,
  referencedBy: string,
) => {
  if (!(await Bun.file(filePath).exists())) {
    throw new Error(
      `${referencedBy} references missing export asset ${path.relative(exportDirectory, filePath)}`,
    )
  }
}

const validateExportHtml = async (relativeHtmlPath: string) => {
  const htmlPath = path.join(exportDirectory, relativeHtmlPath)
  await assertExportFileExists(htmlPath, "Cosmos export")
  const html = await Bun.file(htmlPath).text()
  if (sourceModulePattern.test(html)) {
    throw new Error(
      `${relativeHtmlPath} contains an unbundled source-module reference`,
    )
  }

  for (const match of html.matchAll(localAssetPattern)) {
    const reference = match[1]!.split(/[?#]/, 1)[0]!
    if (
      !reference ||
      reference.startsWith("#") ||
      reference.startsWith("data:") ||
      /^[a-z]+:\/\//i.test(reference) ||
      reference.startsWith("//")
    ) {
      continue
    }
    const assetPath = reference.startsWith("/")
      ? path.join(exportDirectory, reference.slice(1))
      : path.resolve(path.dirname(htmlPath), reference)
    if (
      assetPath !== exportDirectory &&
      !assetPath.startsWith(`${exportDirectory}${path.sep}`)
    ) {
      throw new Error(
        `${relativeHtmlPath} references an asset outside the export`,
      )
    }
    await assertExportFileExists(assetPath, relativeHtmlPath)
  }
}

await validateExportHtml("index.html")
await validateExportHtml("renderer.html")

const manifestPath = path.join(exportDirectory, "cosmos.fixtures.json")
await assertExportFileExists(manifestPath, "Cosmos export")
const manifest = (await Bun.file(manifestPath).json()) as CosmosFixtureManifest
const fixtureFiles = manifest.fixtures.map((fixture) => fixture.filePath).sort()
if (JSON.stringify(fixtureFiles) !== JSON.stringify(expectedFixtureFiles)) {
  throw new Error(
    `Expected exactly the two passing BGA fixtures and the full-SoC failing repro, found ${fixtureFiles.join(", ")}`,
  )
}

await assertExportFileExists(
  path.resolve(exportDirectory, manifest.rendererUrl),
  "cosmos.fixtures.json",
)

console.log(
  `Validated Cosmos export: ${fixtureFiles.length} fixtures and bundled local assets`,
)
