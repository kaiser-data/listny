# Homebrew cask for Listny. It belongs in a tap repository (for example
# github.com/kaiser-data/homebrew-tap, file Casks/listny.rb), not in this one.
# After each release: set `version` and the two sha256 values from SHA256SUMS.txt.
cask "listny" do
  version "0.2.0"

  on_arm do
    sha256 "REPLACE_WITH_ARM64_DMG_SHA256"
    url "https://github.com/kaiser-data/listny/releases/download/v#{version}/Listny-#{version}-arm64.dmg"
  end
  on_intel do
    sha256 "REPLACE_WITH_X64_DMG_SHA256"
    url "https://github.com/kaiser-data/listny/releases/download/v#{version}/Listny-#{version}-x64.dmg"
  end

  name "Listny"
  desc "Voice dictation for any app with your own speech-to-text key"
  homepage "https://github.com/kaiser-data/listny"

  depends_on macos: ">= :ventura"

  app "Listny.app"

  # Listny is not notarized by Apple yet, so macOS would refuse to open the downloaded app.
  postflight do
    system_command "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "#{appdir}/Listny.app"]
  end

  zap trash: [
    "~/Library/Application Support/listny",
    "~/Library/Logs/listny",
  ]
end
