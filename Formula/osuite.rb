class Osuite < Formula
  desc "Governed action SDK and runtime hooks for AI agents"
  homepage "https://ond.cc/osuite"
  url "https://github.com/OndCo/osuite-sdk/releases/download/v2.13.0/osuite-2.13.0.tgz"
  sha256 "98807e101bdd5ac20c38f6dd8d28b99b6a92baa75bc230f1fa099d814d3001c4"
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
