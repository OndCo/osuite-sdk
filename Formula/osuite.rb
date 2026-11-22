class Osuite < Formula
  desc "Governed action SDK and runtime hooks for AI agents"
  homepage "https://ond.cc/osuite"
  url "https://github.com/OndCo/osuite-sdk/releases/download/v2.14.0/osuite-2.14.0.tgz"
  sha256 "789aea79bae4295d97371ac80a21e62f038d890e65f3640c711a0660fd0573f3"
  license "MIT"

  depends_on "node"
  depends_on "git"

  def install
    libexec.install Dir["*"]
    (bin/"osuite").write_env_script libexec/"cli.js", PATH: "#{Formula["node"].opt_bin}:#{ENV["PATH"]}"
  end

  test do
    assert_match "OSUITE", shell_output("#{bin}/osuite --help")
  end
end
