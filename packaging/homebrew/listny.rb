# Homebrew cask for Listny. It belongs in a tap repository (now
# github.com/kaiser-data/homebrew-tap, file Casks/listny.rb), not in this one.
# After each release: copy it there and set `version` and the two sha256 values from SHA256SUMS.txt.
cask "listny" do
  version "0.2.0"

  on_arm do
    sha256 "29af51a1bc84cdbc9e84e85c7609ecfc6a2f689629c468e31d2d51050c6a6273"

    url "https://github.com/kaiser-data/listny/releases/download/v#{version}/Listny-#{version}-arm64.dmg"
  end
  on_intel do
    sha256 "c20d7726893652254cc3975b82d731e4b8551030af246e0612afb7f6687b59c6"

    url "https://github.com/kaiser-data/listny/releases/download/v#{version}/Listny-#{version}-x64.dmg"
  end

  name "Listny"
  desc "Voice dictation for any app with your own speech-to-text key"
  homepage "https://github.com/kaiser-data/listny"

  depends_on macos: :ventura

  app "Listny.app"

  # Listny is not notarized by Apple yet, so macOS would refuse to open the downloaded app.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/Listny.app"]
  end

  zap trash: [
    "~/Library/Application Support/listny",
    "~/Library/Logs/listny",
  ]
end
