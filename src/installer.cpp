#include <windows.h>
#include <commctrl.h>
#include <shellapi.h>
#include <shlobj.h>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace fs = std::filesystem;
constexpr wchar_t CLASS_NAME[] = L"RazerTrayPatchInstaller14";
constexpr UINT WM_FINISHED = WM_APP + 1;
constexpr int APPLY = 101, RESTORE = 102, CLOSE = 103;
HINSTANCE instance;
HWND mainWindow, statusLabel, progressBar, applyButton, restoreButton, closeButton;
HFONT font, headingFont;
bool busy = false;
int dpi = 96;
fs::path engine, payload;

struct Result { bool ok; std::wstring message; };
struct ProcessResult { DWORD code; std::string output; };

std::wstring Wide(const std::string& text) {
    if (text.empty()) return {};
    int size = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
    std::wstring result(size, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), result.data(), size);
    return result;
}

std::string Read(const fs::path& path) {
    std::ifstream input(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

fs::path KnownFolder(REFKNOWNFOLDERID id) {
    PWSTR value = nullptr;
    if (FAILED(SHGetKnownFolderPath(id, 0, nullptr, &value))) throw std::runtime_error("Cannot locate the Windows application folder");
    fs::path result(value);
    CoTaskMemFree(value);
    return result;
}

fs::path FindEngine() {
    for (const auto& id : {FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86}) {
        auto candidate = KnownFolder(id) / L"Razer/RazerAppEngine/app-4.0.896/RazerAppEngine.exe";
        if (fs::is_regular_file(candidate)) return candidate;
    }
    return {};
}

void ExtractResource(int id, const fs::path& target) {
    HRSRC resource = FindResourceW(instance, MAKEINTRESOURCEW(id), RT_RCDATA);
    if (!resource) throw std::runtime_error("Embedded patch resource is missing");
    HGLOBAL loaded = LoadResource(instance, resource);
    const auto* bytes = static_cast<const char*>(LockResource(loaded));
    DWORD size = SizeofResource(instance, resource);
    if (!bytes || !size) throw std::runtime_error("Cannot read embedded patch resource");
    std::ofstream output(target, std::ios::binary | std::ios::trunc);
    output.write(bytes, size);
    if (!output) throw std::runtime_error("Cannot prepare patch files");
}

void Prepare() {
    payload = KnownFolder(FOLDERID_LocalAppData) / L"RazerTrayBatteryPatch/installer-1.4";
    fs::create_directories(payload / L"icons");
    ExtractResource(2000, payload / L"patch.cjs");
    ExtractResource(2001, payload / L"batteryTrayPatch.js");
    ExtractResource(2002, payload / L"run.cmd");
    for (int percent = 0; percent <= 100; percent += 5) {
        wchar_t filename[32];
        swprintf_s(filename, L"battery_%03d.ico", percent);
        ExtractResource(2100 + percent, payload / L"icons" / filename);
    }
}

std::wstring Quote(const std::wstring& arg) {
    std::wstring result = L"\"";
    unsigned slashes = 0;
    for (wchar_t c : arg) {
        if (c == L'\\') { ++slashes; continue; }
        if (c == L'\"') result.append(slashes * 2 + 1, L'\\');
        else result.append(slashes, L'\\');
        slashes = 0;
        result += c;
    }
    result.append(slashes * 2, L'\\');
    return result + L'\"';
}

std::vector<wchar_t> NodeEnvironment() {
    LPWCH block = GetEnvironmentStringsW();
    if (!block) throw std::runtime_error("Cannot read the process environment");
    std::vector<std::wstring> entries;
    for (const wchar_t* entry = block; *entry; entry += wcslen(entry) + 1) {
        std::wstring value(entry);
        const auto end = value.find(L'=', value[0] == L'=' ? 1 : 0);
        std::wstring name = value.substr(0, end);
        if (_wcsicmp(name.c_str(), L"ELECTRON_RUN_AS_NODE") && _wcsicmp(name.c_str(), L"NODE_OPTIONS") && _wcsicmp(name.c_str(), L"NODE_INSPECT_RESUME_ON_START")) entries.push_back(value);
    }
    FreeEnvironmentStringsW(block);
    entries.push_back(L"ELECTRON_RUN_AS_NODE=1");
    std::sort(entries.begin(), entries.end(), [](const auto& a, const auto& b) { return _wcsicmp(a.c_str(), b.c_str()) < 0; });
    std::vector<wchar_t> result;
    for (const auto& entry : entries) { result.insert(result.end(), entry.begin(), entry.end()); result.push_back(0); }
    result.push_back(0);
    return result;
}

ProcessResult RunNode(const std::wstring& action) {
    SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
    HANDLE readPipe, writePipe;
    if (!CreatePipe(&readPipe, &writePipe, &sa, 0)) throw std::runtime_error("Cannot create the operation log pipe");
    SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0);
    HANDLE input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_HIDE;
    startup.hStdInput = input;
    startup.hStdOutput = startup.hStdError = writePipe;
    PROCESS_INFORMATION process{};
    auto environment = NodeEnvironment();
    std::wstring command = Quote(engine.wstring()) + L" " + Quote((payload / L"patch.cjs").wstring()) + L" " + action;
    BOOL created = CreateProcessW(engine.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, environment.data(), payload.c_str(), &startup, &process);
    CloseHandle(writePipe);
    if (input != INVALID_HANDLE_VALUE) CloseHandle(input);
    if (!created) { CloseHandle(readPipe); throw std::runtime_error("Cannot start the installed Razer runtime"); }
    std::string output;
    char buffer[4096];
    DWORD read;
    while (ReadFile(readPipe, buffer, sizeof(buffer), &read, nullptr) && read) output.append(buffer, read);
    CloseHandle(readPipe);
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return {code, output};
}

Result Operate(const std::wstring& action) {
    const fs::path logPath = payload / L"patch-result.log";
    const auto before = fs::exists(logPath) ? fs::file_size(logPath) : 0;
    std::wstring worker = (payload / L"run.cmd").wstring();
    std::wstring arguments = action + L" elevated";
    SHELLEXECUTEINFOW shell{};
    shell.cbSize = sizeof(shell);
    shell.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC;
    shell.hwnd = mainWindow;
    shell.lpVerb = L"runas";
    shell.lpFile = worker.c_str();
    shell.lpParameters = arguments.c_str();
    shell.lpDirectory = payload.c_str();
    shell.nShow = SW_HIDE;
    if (!ShellExecuteExW(&shell)) {
        if (GetLastError() == ERROR_CANCELLED) return {false, L"已取消 Windows 权限确认，未执行本次操作。"};
        return {false, L"无法启动应用补丁所需的权限确认。"};
    }
    WaitForSingleObject(shell.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(shell.hProcess, &code);
    CloseHandle(shell.hProcess);
    std::string all = Read(logPath);
    std::string output = before < all.size() ? all.substr(static_cast<size_t>(before)) : std::string();
    if (code != 0) return {false, L"操作未完成。详细原因已保存到：\r\n" + logPath.wstring()};
    if (output.find("already installed. Nothing changed.") != std::string::npos) return {true, L"已安装当前版本补丁，无需重复应用。"};
    if (output.find("Original version is already installed.") != std::string::npos) return {true, L"当前已经是原版，无需恢复。"};
    auto restarted = RunNode(L"restart");
    std::ofstream log(logPath, std::ios::binary | std::ios::app);
    log << restarted.output;
    if (restarted.code != 0) return {false, L"Synapse 启动检查未通过。请查看日志中的恢复结果：\r\n" + logPath.wstring()};
    return {true, action == L"apply" ? L"补丁已应用，Synapse 已重新启动。\r\n设备连接完成后，圆环和悬停电量即可显示。" : L"原版已恢复，Synapse 已重新启动。"};
}

int Scale(int value) { return MulDiv(value, dpi, 96); }

HWND Control(const wchar_t* type, const wchar_t* text, DWORD style, int x, int y, int width, int height, int id = 0) {
    HWND control = CreateWindowExW(0, type, text, WS_CHILD | WS_VISIBLE | style, Scale(x), Scale(y), Scale(width), Scale(height), mainWindow, reinterpret_cast<HMENU>(static_cast<INT_PTR>(id)), instance, nullptr);
    SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(font), TRUE);
    return control;
}

LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
    case WM_CREATE: {
        mainWindow = window;
        font = CreateFontW(-Scale(15), 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Microsoft YaHei UI");
        headingFont = CreateFontW(-Scale(22), 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Microsoft YaHei UI");
        HWND heading = Control(L"STATIC", L"雷蛇电量图标补丁", 0, 26, 23, 470, 36);
        SendMessageW(heading, WM_SETFONT, reinterpret_cast<WPARAM>(headingFont), TRUE);
        Control(L"STATIC", L"适用：Razer Synapse 4.0.896  ·  补丁 1.4", 0, 26, 67, 470, 24);
        Control(L"STATIC", L"21 档电量圆环，40 像素原始图案。\r\n悬停显示实际电量，保留原来的点击和菜单。", 0, 26, 104, 470, 50);
        statusLabel = Control(L"STATIC", engine.empty() ? L"未找到受支持的 Synapse 4.0.896 安装。" : L"应用或恢复时需要 Windows 授权，并会重启 Synapse。", 0, 26, 174, 470, 50);
        progressBar = Control(PROGRESS_CLASSW, L"", PBS_MARQUEE, 26, 234, 470, 6);
        ShowWindow(progressBar, SW_HIDE);
        applyButton = Control(L"BUTTON", L"应用补丁", WS_TABSTOP | BS_DEFPUSHBUTTON, 26, 260, 150, 40, APPLY);
        restoreButton = Control(L"BUTTON", L"恢复原版", WS_TABSTOP, 190, 260, 150, 40, RESTORE);
        closeButton = Control(L"BUTTON", L"关闭", WS_TABSTOP, 354, 260, 142, 40, CLOSE);
        EnableWindow(applyButton, !engine.empty());
        EnableWindow(restoreButton, !engine.empty());
        return 0;
    }
    case WM_COMMAND: {
        const int id = LOWORD(wParam);
        if (id == CLOSE) { SendMessageW(window, WM_CLOSE, 0, 0); return 0; }
        if ((id != APPLY && id != RESTORE) || busy) break;
        busy = true;
        EnableWindow(applyButton, FALSE); EnableWindow(restoreButton, FALSE); EnableWindow(closeButton, FALSE);
        SetWindowTextW(statusLabel, L"正在处理，请在 Windows 权限提示中允许操作。\r\n完成后此窗口会显示结果。" );
        ShowWindow(progressBar, SW_SHOW);
        SendMessageW(progressBar, PBM_SETMARQUEE, TRUE, 30);
        std::thread([id] {
            const HRESULT com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
            std::unique_ptr<Result> result;
            try { result = std::make_unique<Result>(Operate(id == APPLY ? L"apply" : L"restore")); }
            catch (const std::exception& error) { result = std::make_unique<Result>(Result{false, L"操作未完成：\r\n" + Wide(error.what())}); }
            if (SUCCEEDED(com)) CoUninitialize();
            PostMessageW(mainWindow, WM_FINISHED, 0, reinterpret_cast<LPARAM>(result.release()));
        }).detach();
        return 0;
    }
    case WM_FINISHED: {
        std::unique_ptr<Result> result(reinterpret_cast<Result*>(lParam));
        busy = false;
        ShowWindow(progressBar, SW_HIDE);
        SendMessageW(progressBar, PBM_SETMARQUEE, FALSE, 0);
        EnableWindow(applyButton, TRUE); EnableWindow(restoreButton, TRUE); EnableWindow(closeButton, TRUE);
        SetWindowTextW(statusLabel, result->message.c_str());
        if (!result->ok) MessageBoxW(window, result->message.c_str(), L"未完成操作", MB_OK | MB_ICONWARNING);
        return 0;
    }
    case WM_CTLCOLORSTATIC:
        SetBkColor(reinterpret_cast<HDC>(wParam), GetSysColor(COLOR_WINDOW));
        return reinterpret_cast<LRESULT>(GetSysColorBrush(COLOR_WINDOW));
    case WM_CLOSE:
        if (!busy) DestroyWindow(window);
        return 0;
    case WM_DESTROY:
        DeleteObject(font); DeleteObject(headingFont);
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(window, message, wParam, lParam);
}

int WINAPI wWinMain(HINSTANCE current, HINSTANCE, PWSTR, int show) {
    instance = current;
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    try {
        Prepare();
        engine = FindEngine();
        int argc = 0;
        LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
        if (argc == 3 && std::wstring(argv[1]) == L"--self-test") {
            if (engine.empty()) throw std::runtime_error("Supported Razer runtime not found");
            auto result = RunNode(L"status");
            std::ofstream log(fs::path(argv[2]), std::ios::binary);
            log << result.output;
            LocalFree(argv);
            return result.code == 0 && result.output.find("\"patchInfo\"") != std::string::npos ? 0 : 1;
        }
        LocalFree(argv);
    } catch (const std::exception& error) {
        MessageBoxW(nullptr, (L"无法准备补丁工具：\r\n" + Wide(error.what())).c_str(), L"雷蛇电量图标补丁", MB_OK | MB_ICONERROR);
        return 1;
    }
    dpi = static_cast<int>(GetDpiForSystem());
    INITCOMMONCONTROLSEX controls{sizeof(controls), ICC_PROGRESS_CLASS};
    InitCommonControlsEx(&controls);
    WNDCLASSW cls{};
    cls.lpfnWndProc = WindowProc;
    cls.hInstance = instance;
    cls.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(1));
    cls.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    cls.hbrBackground = GetSysColorBrush(COLOR_WINDOW);
    cls.lpszClassName = CLASS_NAME;
    RegisterClassW(&cls);
    RECT size{0, 0, Scale(522), Scale(324)};
    AdjustWindowRectEx(&size, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX, FALSE, 0);
    HWND window = CreateWindowExW(0, CLASS_NAME, L"雷蛇电量图标补丁", WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX, CW_USEDEFAULT, CW_USEDEFAULT, size.right - size.left, size.bottom - size.top, nullptr, nullptr, instance, nullptr);
    if (!window) return 1;
    ShowWindow(window, show);
    UpdateWindow(window);
    MSG message;
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        if (!IsDialogMessageW(window, &message)) { TranslateMessage(&message); DispatchMessageW(&message); }
    }
    CoUninitialize();
    return static_cast<int>(message.wParam);
}
