class Osuite < Formula
  desc "Governed action SDK and runtime hooks for AI agents"
  homepage "https://ond.cc/osuite"
  url "https://github.com/OndCo/osuite-sdk/releases/download/v2.12.0/osuite-2.12.0.tgz"
  sha256 "c1790d98d66d76f3098c424123eeaeab231dc82a92c55cb40c6d60e001a94883"
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
