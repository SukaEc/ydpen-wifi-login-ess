/*
 * panet — 词典笔最小 HTTP JSAPI (从零实现, 仅 POSIX socket, 零第三方依赖)
 *
 * 背景: 该笔固件不向第三方应用提供系统级 http 模块 (js_modules 仅
 * events/qjs-dbus/util), CloudBrowser/bilibili 等应用均自带 native 网络库。
 * 本模块以 JSCModuleExtension 形式注册为 JS 模块 "panet",
 * 供小程序 `import { Panet } from "panet"` 使用。
 *
 * 设计要点:
 *  - 不跟随 302: 连通性测试需要直接看到 Location 头, 才能知道跳转页面与 Portal 服务器 IP
 *  - body 以 base64 返回: Portal 响应为 GB2312, 走 JSON 字符串会破坏字节
 *  - 支持 GET/POST(空 body 或 text body), Transfer-Encoding: chunked 解码
 */

#include <jsmodules/JSCModuleExtension.h>
#include <jquick_config.h>
#include <jqutil_v2/jqutil.h>
#include <jqutil_v2/JQPublishObject.h>

#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <exception>
#include <string>
#include <vector>

using namespace JQUTIL_NS;

static const char *kUserAgent = "panet/0.1 (youdao-pen wifi-login)";

static std::string base64Encode(const std::string &in)
{
    static const char *tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((in.size() + 2) / 3) * 4);
    size_t i = 0;
    while (i + 2 < in.size()) {
        unsigned v = (unsigned char)in[i] << 16 | (unsigned char)in[i + 1] << 8 | (unsigned char)in[i + 2];
        out.push_back(tbl[(v >> 18) & 0x3f]);
        out.push_back(tbl[(v >> 12) & 0x3f]);
        out.push_back(tbl[(v >> 6) & 0x3f]);
        out.push_back(tbl[v & 0x3f]);
        i += 3;
    }
    if (i + 1 == in.size()) {
        unsigned v = (unsigned char)in[i] << 16;
        out.push_back(tbl[(v >> 18) & 0x3f]);
        out.push_back(tbl[(v >> 12) & 0x3f]);
        out.push_back('=');
        out.push_back('=');
    } else if (i + 2 == in.size()) {
        unsigned v = (unsigned char)in[i] << 16 | (unsigned char)in[i + 1] << 8;
        out.push_back(tbl[(v >> 18) & 0x3f]);
        out.push_back(tbl[(v >> 12) & 0x3f]);
        out.push_back(tbl[(v >> 6) & 0x3f]);
        out.push_back('=');
    }
    return out;
}

static std::string jsonEscape(const std::string &in)
{
    std::string out;
    out.reserve(in.size());
    char buf[8];
    for (size_t i = 0; i < in.size(); i++) {
        unsigned char c = (unsigned char)in[i];
        if (c == '"' || c == '\\') {
            out.push_back('\\');
            out.push_back((char)c);
        } else if (c < 0x20 || c == 0x7f) {
            snprintf(buf, sizeof(buf), "\\u%04x", c);
            out += buf;
        } else {
            out.push_back((char)c);
        }
    }
    return out;
}

struct UrlParts {
    std::string host;
    std::string port;
    std::string path; // 以 / 开头, 含 query
};

static UrlParts parseUrl(const std::string &url)
{
    UrlParts u;
    u.port = "80";
    std::string rest = url;
    if (rest.rfind("http://", 0) == 0) {
        rest = rest.substr(7);
    } else if (rest.rfind("https://", 0) == 0) {
        // https 不在本模块支持范围 (portal 场景全部为 http)
        throw std::runtime_error("https not supported, use http");
    }
    size_t slash = rest.find('/');
    std::string hostPort = slash == std::string::npos ? rest : rest.substr(0, slash);
    u.path = slash == std::string::npos ? "/" : rest.substr(slash);
    if (!hostPort.empty() && hostPort[0] == '[') {
        // ipv6 [::1]:8080
        size_t rb = hostPort.find(']');
        if (rb == std::string::npos) throw std::runtime_error("bad ipv6 url");
        u.host = hostPort.substr(1, rb - 1);
        if (rb + 1 < hostPort.size() && hostPort[rb + 1] == ':')
            u.port = hostPort.substr(rb + 2);
    } else {
        size_t colon = hostPort.rfind(':');
        if (colon == std::string::npos) {
            u.host = hostPort;
        } else {
            u.host = hostPort.substr(0, colon);
            u.port = hostPort.substr(colon + 1);
        }
    }
    if (u.host.empty()) throw std::runtime_error("empty host");
    return u;
}

class TcpConn {
public:
    ~TcpConn() { closeFd(); }

    void connect(const std::string &host, const std::string &port, int timeoutSec)
    {
        struct addrinfo hints;
        memset(&hints, 0, sizeof(hints));
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;

        struct addrinfo *res = NULL;
        int rc = getaddrinfo(host.c_str(), port.c_str(), &hints, &res);
        if (rc != 0 || res == NULL)
            throw std::runtime_error("dns resolve failed: " + host);

        int lastErr = 0;
        for (struct addrinfo *ai = res; ai != NULL; ai = ai->ai_next) {
            int fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
            if (fd < 0) {
                lastErr = errno;
                continue;
            }
            // 非阻塞 connect + poll 超时
            int flags = fcntl(fd, F_GETFL, 0);
            fcntl(fd, F_SETFL, flags | O_NONBLOCK);
            rc = ::connect(fd, ai->ai_addr, ai->ai_addrlen);
            if (rc != 0 && errno != EINPROGRESS) {
                lastErr = errno;
                ::close(fd);
                continue;
            }
            if (rc != 0) {
                struct pollfd pfd;
                pfd.fd = fd;
                pfd.events = POLLOUT;
                rc = poll(&pfd, 1, timeoutSec * 1000);
                if (rc <= 0) {
                    lastErr = rc == 0 ? ETIMEDOUT : errno;
                    ::close(fd);
                    continue;
                }
                int soerr = 0;
                socklen_t slen = sizeof(soerr);
                getsockopt(fd, SOL_SOCKET, SO_ERROR, &soerr, &slen);
                if (soerr != 0) {
                    lastErr = soerr;
                    ::close(fd);
                    continue;
                }
            }
            fcntl(fd, F_SETFL, flags); // 恢复阻塞模式
            _fd = fd;
            break;
        }
        freeaddrinfo(res);
        if (_fd < 0)
            throw std::runtime_error("connect failed: " + host + ":" + port + " errno=" + std::to_string(lastErr));

        struct timeval tv;
        tv.tv_sec = timeoutSec;
        tv.tv_usec = 0;
        setsockopt(_fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        setsockopt(_fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    }

    void sendAll(const std::string &data)
    {
        size_t off = 0;
        while (off < data.size()) {
            ssize_t n = ::send(_fd, data.data() + off, data.size() - off, 0);
            if (n <= 0) throw std::runtime_error("send failed errno=" + std::to_string(errno));
            off += (size_t)n;
        }
    }

    // 读到对端关闭或超时; 超时抛出
    std::string recvAll()
    {
        std::string out;
        char buf[4096];
        for (;;) {
            ssize_t n = ::recv(_fd, buf, sizeof(buf), 0);
            if (n == 0) break;
            if (n < 0) {
                if (errno == EINTR) continue;
                if (out.empty()) throw std::runtime_error("recv failed errno=" + std::to_string(errno));
                break; // 已有部分数据, 收下
            }
            out.append(buf, (size_t)n);
            if (out.size() > 4 * 1024 * 1024) throw std::runtime_error("response too large");
        }
        return out;
    }

private:
    void closeFd()
    {
        if (_fd >= 0) ::close(_fd);
        _fd = -1;
    }
    int _fd = -1;
};

struct HttpResponse {
    int statusCode = 0;
    std::vector<std::string> headerLines;
    std::string body;
};

static std::string toLower(std::string s)
{
    for (size_t i = 0; i < s.size(); i++)
        if (s[i] >= 'A' && s[i] <= 'Z') s[i] = (char)(s[i] - 'A' + 'a');
    return s;
}

static std::string trim(const std::string &s)
{
    size_t b = s.find_first_not_of(" \t\r\n");
    if (b == std::string::npos) return "";
    size_t e = s.find_last_not_of(" \t\r\n");
    return s.substr(b, e - b + 1);
}

// 解析头 + 按 Content-Length / chunked 截取 body
static HttpResponse parseResponse(const std::string &raw)
{
    HttpResponse r;
    size_t headerEnd = raw.find("\r\n\r\n");
    size_t sepLen = 4;
    if (headerEnd == std::string::npos) {
        headerEnd = raw.find("\n\n");
        sepLen = 2;
    }
    std::string head = headerEnd == std::string::npos ? raw : raw.substr(0, headerEnd);
    std::string body = headerEnd == std::string::npos ? "" : raw.substr(headerEnd + sepLen);

    size_t lineStart = 0;
    bool first = true;
    std::string transferEncoding, contentLength;
    while (lineStart < head.size()) {
        size_t lineEnd = head.find('\n', lineStart);
        std::string line = trim(lineEnd == std::string::npos ? head.substr(lineStart) : head.substr(lineStart, lineEnd - lineStart));
        lineStart = lineEnd == std::string::npos ? head.size() : lineEnd + 1;
        if (line.empty()) continue;
        if (first) {
            first = false;
            // HTTP/1.1 302 Found
            size_t sp1 = line.find(' ');
            size_t sp2 = sp1 == std::string::npos ? std::string::npos : line.find(' ', sp1 + 1);
            if (sp1 != std::string::npos && sp2 != std::string::npos)
                r.statusCode = atoi(line.substr(sp1 + 1, sp2 - sp1 - 1).c_str());
            continue;
        }
        size_t colon = line.find(':');
        if (colon == std::string::npos) continue;
        std::string key = toLower(trim(line.substr(0, colon)));
        std::string val = trim(line.substr(colon + 1));
        if (key == "transfer-encoding") transferEncoding = toLower(val);
        else if (key == "content-length") contentLength = val;
        r.headerLines.push_back(line);
    }

    bool chunked = transferEncoding.find("chunked") != std::string::npos;
    if (chunked) {
        // dechunk
        std::string out;
        size_t pos = 0;
        for (;;) {
            size_t eol = body.find("\r\n", pos);
            if (eol == std::string::npos) break;
            std::string sizeLine = trim(body.substr(pos, eol - pos));
            size_t semi = sizeLine.find(';');
            if (semi != std::string::npos) sizeLine = sizeLine.substr(0, semi);
            unsigned long chunkLen = strtoul(sizeLine.c_str(), NULL, 16);
            pos = eol + 2;
            if (chunkLen == 0) break;
            if (pos + chunkLen > body.size()) {
                out += body.substr(pos);
                pos = body.size();
                break;
            }
            out += body.substr(pos, chunkLen);
            pos += chunkLen + 2; // 跳过块尾 CRLF
        }
        r.body = out;
    } else if (!contentLength.empty()) {
        unsigned long len = strtoul(contentLength.c_str(), NULL, 10);
        r.body = body.substr(0, len < body.size() ? len : body.size());
    } else {
        r.body = body;
    }
    return r;
}

static HttpResponse httpFetch(const std::string &url, const std::string &method, int timeoutSec,
                              const std::string &body = "")
{
    UrlParts u = parseUrl(url);
    TcpConn conn;
    conn.connect(u.host, u.port, timeoutSec);

    bool isPost = method == "POST";
    std::string req;
    req += (isPost ? "POST " : "GET ") + u.path + " HTTP/1.1\r\n";
    req += "Host: " + u.host + (u.port == "80" ? "" : ":" + u.port) + "\r\n";
    req += std::string("User-Agent: ") + kUserAgent + "\r\n";
    req += "Accept: */*\r\n";
    if (isPost) {
        // 支持表单 body (华为 ESS 等需要 POST form); 无 body 时保持空 POST
        req += "Content-Type: application/x-www-form-urlencoded\r\n";
        req += "Content-Length: " + std::to_string(body.size()) + "\r\n";
    }
    req += "Connection: close\r\n\r\n";
    if (isPost && !body.empty()) {
        req += body;
    }

    conn.sendAll(req);
    std::string raw = conn.recvAll();
    if (raw.empty()) throw std::runtime_error("empty response");
    return parseResponse(raw);
}

// 逐级创建目录 (含最后一段), 已存在则忽略
static void mkdirsOf(const std::string &path)
{
    size_t pos = 0;
    for (;;) {
        pos = path.find('/', pos + 1);
        if (pos == std::string::npos) break;
        std::string dir = path.substr(0, pos);
        if (!dir.empty()) mkdir(dir.c_str(), 0755);
    }
    mkdir(path.c_str(), 0755);
}

static long fileSizeOf(const std::string &path)
{
    FILE *f = fopen(path.c_str(), "rb");
    if (!f) return -1;
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fclose(f);
    return size;
}

// 执行 shell 命令并捕获 stdout (失败返回空串); 用于读取 wpa_cli/iw 输出
static std::string runCmd(const std::string &cmd)
{
    std::string out;
    FILE *p = popen(cmd.c_str(), "r");
    if (!p) return out;
    char buf[512];
    size_t n;
    // 输出有界 (最多 8KB), 避免异常情况下无限读
    while ((n = fread(buf, 1, sizeof(buf), p)) > 0 && out.size() < 8192) out.append(buf, n);
    pclose(p);
    return out;
}

// 逐行找以 prefix 开头的行, 返回其后的值 (去掉前导空白与尾部 CR/LF)
static std::string grepSsid(const std::string &text, const std::string &prefix)
{
    size_t pos = 0;
    while (pos < text.size()) {
        size_t eol = text.find('\n', pos);
        std::string line = text.substr(pos, eol == std::string::npos ? std::string::npos : eol - pos);
        pos = (eol == std::string::npos) ? text.size() : eol + 1;
        // 允许行首有空白 (wpa_cli 输出为 "ssid=xxx", iw 输出为 "\tSSID: xxx")
        size_t s = line.find_first_not_of(" \t");
        if (s == std::string::npos) continue;
        std::string trimmed = line.substr(s);
        if (trimmed.size() <= prefix.size()) continue;
        if (trimmed.compare(0, prefix.size(), prefix) != 0) continue;
        std::string val = trimmed.substr(prefix.size());
        size_t vs = val.find_first_not_of(" \t");
        if (vs != std::string::npos) val = val.substr(vs);
        while (!val.empty() && (val[val.size() - 1] == '\r' || val[val.size() - 1] == '\n' || val[val.size() - 1] == ' '))
            val.erase(val.size() - 1);
        return val;
    }
    return std::string();
}

// 从 /proc/net/wireless 解析无线接口名; 取不到默认 wlan0
static std::string wirelessIface()
{
    FILE *f = fopen("/proc/net/wireless", "rb");
    if (!f) return "wlan0";
    std::string text;
    char buf[1024];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) text.append(buf, n);
    fclose(f);

    size_t pos = 0;
    while (pos < text.size()) {
        size_t eol = text.find('\n', pos);
        std::string line = text.substr(pos, eol == std::string::npos ? std::string::npos : eol - pos);
        pos = (eol == std::string::npos) ? text.size() : eol + 1;
        size_t colon = line.find(':');
        if (colon == std::string::npos) continue;
        std::string name = line.substr(0, colon);
        size_t s = name.find_first_not_of(" \t");
        if (s == std::string::npos) continue;
        size_t e = name.find_last_not_of(" \t");
        name = name.substr(s, e - s + 1);
        // 跳过表头行 (Inter-| sta- ...)
        if (name.empty() || name.find('-') != std::string::npos) continue;
        if (name == "face") continue;
        return name;
    }
    return "wlan0";
}

class Panet : public JQPublishObject {
public:
    // request(url, method, timeoutSec, body) -> Promise<{statusCode, headers[], body(b64)}>
    void request(JQAsyncInfo &info)
    {
        try {
            if (info.Length() < 1 || !info[0].is_string())
                throw std::runtime_error("usage: request(url, method='GET', timeoutSec=8)");
            std::string url = info[0].string_value();
            std::string method = info.Length() > 1 && info[1].is_string() ? info[1].string_value() : "GET";
            int timeoutSec = info.Length() > 2 && info[2].is_number() ? info[2].int_value() : 8;
            if (timeoutSec <= 0 || timeoutSec > 60) timeoutSec = 8;
            std::string body = info.Length() > 3 && info[3].is_string() ? info[3].string_value() : "";

            HttpResponse r = httpFetch(url, method, timeoutSec, body);

            std::string headersJson;
            for (size_t i = 0; i < r.headerLines.size(); i++) {
                if (i) headersJson += ",";
                headersJson += "\"" + jsonEscape(r.headerLines[i]) + "\"";
            }
            std::string json = "{\"statusCode\":" + std::to_string(r.statusCode) +
                               ",\"headers\":[" + headersJson + "]" +
                               ",\"body\":\"" + base64Encode(r.body) + "\"}";
            info.postJSON(json);
        } catch (const std::exception &e) {
            info.postError(e.what());
        } catch (...) {
            info.postError("unknown panet error");
        }
    }

    // writeFile(path, text) -> Promise<true>  (覆盖写, 供记住密码等持久化使用)
    void writeFile(JQAsyncInfo &info)
    {
        try {
            if (info.Length() < 2 || !info[0].is_string() || !info[1].is_string())
                throw std::runtime_error("usage: writeFile(path, text)");
            std::string path = info[0].string_value();
            std::string data = info[1].string_value();
            FILE *f = fopen(path.c_str(), "wb");
            if (!f) throw std::runtime_error("open for write failed: " + path + " errno=" + std::to_string(errno));
            size_t n = fwrite(data.data(), 1, data.size(), f);
            fclose(f);
            if (n != data.size()) throw std::runtime_error("short write: " + path);
            info.post(true);
        } catch (const std::exception &e) {
            info.postError(e.what());
        } catch (...) {
            info.postError("unknown panet error");
        }
    }

    // appendFile(path, text) -> Promise<true>  (追加写; 超过 512KB 自动截断轮转)
    void appendFile(JQAsyncInfo &info)
    {
        try {
            if (info.Length() < 2 || !info[0].is_string() || !info[1].is_string())
                throw std::runtime_error("usage: appendFile(path, text)");
            std::string path = info[0].string_value();
            std::string data = info[1].string_value();
            mkdirsOf(path.substr(0, path.find_last_of('/')));
            if (fileSizeOf(path) > 512 * 1024) {
                FILE *t = fopen(path.c_str(), "wb");
                if (t) fclose(t);
            }
            FILE *f = fopen(path.c_str(), "ab");
            if (!f) throw std::runtime_error("open for append failed: " + path + " errno=" + std::to_string(errno));
            size_t n = fwrite(data.data(), 1, data.size(), f);
            fclose(f);
            if (n != data.size()) throw std::runtime_error("short append: " + path);
            info.post(true);
        } catch (const std::exception &e) {
            info.postError(e.what());
        } catch (...) {
            info.postError("unknown panet error");
        }
    }

    // mkdirs(path) -> Promise<true>  (逐级创建目录)
    void mkdirs(JQAsyncInfo &info)
    {
        try {
            if (info.Length() < 1 || !info[0].is_string())
                throw std::runtime_error("usage: mkdirs(path)");
            mkdirsOf(info[0].string_value());
            info.post(true);
        } catch (const std::exception &e) {
            info.postError(e.what());
        } catch (...) {
            info.postError("unknown panet error");
        }
    }

    // readFile(path) -> Promise<string>  (不存在/失败返回空串)
    void readFile(JQAsyncInfo &info)
    {
        try {
            if (info.Length() < 1 || !info[0].is_string())
                throw std::runtime_error("usage: readFile(path)");
            std::string path = info[0].string_value();
            FILE *f = fopen(path.c_str(), "rb");
            if (!f) {
                info.post(std::string());
                return;
            }
            std::string out;
            char buf[4096];
            size_t n;
            while ((n = fread(buf, 1, sizeof(buf), f)) > 0) out.append(buf, n);
            fclose(f);
            info.post(out);
        } catch (const std::exception &e) {
            info.postError(e.what());
        } catch (...) {
            info.postError("unknown panet error");
        }
    }

    // wifiSsid() -> Promise<string>  (当前连接的 WiFi 名称; 取不到返回空串)
    // 固件未暴露 SSID 查询 JSAPI, 这里按可靠性依次尝试:
    //   1) iw dev <if> link   (首选: 直接读内核 nl80211, 不依赖 supplicant socket)
    //   2) wpa_cli -i <if> status
    // 接口名从 /proc/net/wireless 解析, 取不到则默认 wlan0。
    void wifiSsid(JQAsyncInfo &info)
    {
        try {
            std::string ifc = wirelessIface();
            std::string ssid;

            ssid = grepSsid(runCmd("iw dev " + ifc + " link 2>/dev/null"), "SSID:");
            if (ssid.empty())
                ssid = grepSsid(runCmd("wpa_cli -i " + ifc + " status 2>/dev/null"), "ssid=");

            info.post(ssid);
        } catch (const std::exception &e) {
            info.postError(e.what());
        } catch (...) {
            info.postError("unknown panet error");
        }
    }
};

static JSValue createPanet(JQModuleEnv *env)
{
    JQFunctionTemplateRef tpl = JQFunctionTemplate::New(env, "Panet");
    tpl->InstanceTemplate()->setObjectCreator([]() {
        return new Panet();
    });
    tpl->SetProtoMethodPromise("request", &Panet::request);
    tpl->SetProtoMethodPromise("writeFile", &Panet::writeFile);
    tpl->SetProtoMethodPromise("appendFile", &Panet::appendFile);
    tpl->SetProtoMethodPromise("mkdirs", &Panet::mkdirs);
    tpl->SetProtoMethodPromise("readFile", &Panet::readFile);
    tpl->SetProtoMethodPromise("wifiSsid", &Panet::wifiSsid);
    return tpl->CallConstructor();
}

static std::vector<std::string> exportList = {"Panet"};

static int module_init(JSContext *ctx, JSModuleDef *m)
{
    auto env = JQModuleEnv::CreateModule(ctx, m, "panet");
    env->setModuleExport("Panet", createPanet(env.get()));
    env->setModuleExportDone(JS_UNDEFINED, exportList);
    return 0;
}

DEF_MODULE_LOAD_FUNC_EXPORT(panet, module_init, exportList)

extern "C" JQUICK_EXPORT void custom_init_jsapis()
{
    registerCModuleLoader("panet", &panet_module_load);
}
