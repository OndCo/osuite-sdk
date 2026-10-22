class Osuite < Formula
  desc "Governed action SDK and runtime hooks for AI agents"
  homepage "https://ond.cc/osuite"
  url "https://github.com/OndCo/osuite-sdk/releases/download/v2.10.2/osuite-2.10.2.tgz"
  sha256 "b37b02972d434f81e44d52010d55e99d6c6782a085c59ce97ff832ae3a1842a0"
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
