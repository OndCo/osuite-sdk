class Osuite < Formula
  desc "Governed action SDK and runtime hooks for AI agents"
  homepage "https://ond.cc/osuite"
  url "https://github.com/OndCo/osuite-sdk/releases/download/v2.11.0/osuite-2.11.0.tgz"
  sha256 "7c0e3aa45e7768ad6920536a37defb228670dea150be60248bfa07488431deaa"
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
