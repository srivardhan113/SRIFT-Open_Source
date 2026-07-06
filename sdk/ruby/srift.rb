# SRIFT Ruby SDK — zero-dep client. Ruby 2.7+ / 3.x / JRuby / TruffleRuby.
#
#   require_relative 'srift'
#   s = Srift::Client.new
#   r = s.quick_share('/abs/path/file.zip')
#   puts r['shareUrl']

require 'net/http'
require 'json'
require 'uri'

module Srift
  class Error < StandardError; end

  class Client
    DEFAULT_BASE = 'http://127.0.0.1:3822'

    def initialize(base_url: nil, timeout: 30)
      @base = (base_url || ENV['SRIFT_BASE_URL'] || DEFAULT_BASE).chomp('/')
      @timeout = timeout
    end

    def status;             get('/status');                end
    def state;              get('/state');                 end
    def chat_history;       get('/chat/history');          end

    def quick_share(file_path, session_name: nil)
      post('/quick-share', filePath: file_path, sessionName: session_name)
    end
    def start_session(name: nil, room_secret: nil)
      post('/session/start', sessionName: name, roomSecret: room_secret)
    end
    def join_session(session_id, username: nil, room_secret: nil)
      post('/session/join', sessionId: session_id, username: username, roomSecret: room_secret)
    end
    def approve_join(temp_user_id); post('/session/approve', tempUserId: temp_user_id); end
    def reject_join(temp_user_id, reason: nil); post('/session/reject', tempUserId: temp_user_id, reason: reason); end
    def kick_user(user_id); post('/session/kick', userId: user_id); end
    def close_session;      post('/session/close');                  end
    def send_file(file_path, protocol: nil); post('/send', filePath: file_path, protocol: protocol); end
    def accept_transfer(file_id, save_dir: nil); post('/receive', fileId: file_id, saveDir: save_dir); end
    def send_chat(message); post('/chat/send', message: message); end
    def list_transfers
      status['activeTransfers'] || []
    end

    private

    def get(path);  do_request(Net::HTTP::Get.new(URI(@base + path))); end
    def post(path, body = {})
      req = Net::HTTP::Post.new(URI(@base + path), 'Content-Type' => 'application/json')
      req.body = JSON.generate(body.compact)
      do_request(req)
    end

    def do_request(req)
      uri = req.uri
      res = Net::HTTP.start(uri.host, uri.port, read_timeout: @timeout) { |h| h.request(req) }
      raise Error, JSON.parse(res.body)['error'] || "HTTP #{res.code}" if res.code.to_i >= 400
      res.body.empty? ? {} : JSON.parse(res.body)
    rescue Errno::ECONNREFUSED => e
      raise Error, "Daemon unreachable at #{@base}: #{e.message}. Start it with: srift daemon start"
    end
  end
end
