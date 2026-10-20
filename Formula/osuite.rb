class Osuite < Formula
  desc "Governed action SDK and runtime hooks for AI agents"
  homepage "https://ond.cc/osuite"
  url "https://github.com/OndCo/osuite-sdk/releases/download/v2.10.1/osuite-2.10.1.tgz"
  sha256 "b758f98c6b33587eb123dcc803a4e66cce931237102d6d74a280da59ea2d1604"
  license "MIT"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    (bin/"osuite").write_env_script libexec/"cli.js", PATH: "#{Formula["node"].opt_bin}:#{ENV["PATH"]}"
  end

  test do
    assert_match "OSUITE", shell_output("#{bin}/osuite --help")
  end
end
