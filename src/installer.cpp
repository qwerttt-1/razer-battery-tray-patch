#include <windows.h>
#include <commctrl.h>
#include <shellapi.h>
#include <shlobj.h>
#include <tlhelp32.h>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <memory>
#include <regex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace fs = std::filesystem;
constexpr wchar_t CLASS_NAME[] = L"RazerTrayPatchInstaller15";
constexpr UINT WM_FINISHED = WM_APP + 1;
constexpr int APPLY = 101, RESTORE = 102, CLOSE = 103, SELECT = 104, FILE_PICK = 105, FOLDER_PICK = 106, RESCAN = 107;
HINSTANCE instance;
HWND mainWindow, statusLabel, progressBar, applyButton, restoreButton, closeButton;
HWND targetCombo, versionLabel, fileButton, folderButton, scanButton;
std::vector<fs::path> candidates;
HFONT font, headingFont;
bool busy = false;
int dpi = 96;
fs::path engine, payload, installer;
std::wstring engineVersion;

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

bool IsEngine(const fs::path& candidate) {
    std::error_code error;
    return _wcsicmp(candidate.filename().c_str(), L"RazerAppEngine.exe") == 0 &&
        fs::is_regular_file(candidate, error) && fs::is_regular_file(candidate.parent_path() / L"resources/app.asar", error);
}

void AddEngine(const fs::path& candidate) {
    if (!IsEngine(candidate)) return;
    const auto absolute = fs::absolute(candidate).lexically_normal();
    if (std::none_of(candidates.begin(), candidates.end(), [&](const auto& item) { return _wcsicmp(item.c_str(), absolute.c_str()) == 0; })) candidates.push_back(absolute);
}

void ScanFolder(const fs::path& folder, int depth = 2) {
    if (folder.empty()) return;
    AddEngine(folder / L"RazerAppEngine.exe");
    if (!depth) return;
    std::error_code error;
    for (const auto& item : fs::directory_iterator(folder, fs::directory_options::skip_permission_denied, error)) {
        if (!item.is_directory(error) || item.is_symlink(error)) continue;
        ScanFolder(item.path(), depth - 1);
    }
}

std::wstring RegistryText(HKEY key, const wchar_t* name) {
    DWORD bytes = 0;
    if (RegGetValueW(key, nullptr, name, RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ, nullptr, nullptr, &bytes) != ERROR_SUCCESS || bytes > 65536) return {};
    std::wstring result(bytes / sizeof(wchar_t), L'\0');
    if (RegGetValueW(key, nullptr, name, RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ, nullptr, result.data(), &bytes) != ERROR_SUCCESS) return {};
    result.resize(wcslen(result.c_str()));
    return result;
}

void Discover() {
    candidates.clear();
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    PROCESSENTRY32W item{}; item.dwSize = sizeof(item);
    if (snapshot != INVALID_HANDLE_VALUE) {
        if (Process32FirstW(snapshot, &item)) do {
            if (_wcsicmp(item.szExeFile, L"RazerAppEngine.exe")) continue;
            HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, item.th32ProcessID);
            if (process) {
                wchar_t filename[32768]; DWORD length = _countof(filename);
                if (QueryFullProcessImageNameW(process, 0, filename, &length)) AddEngine(fs::path(filename));
                CloseHandle(process);
            }
        } while (Process32NextW(snapshot, &item));
        CloseHandle(snapshot);
    }
    for (HKEY hive : {HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER}) for (REGSAM view : {KEY_WOW64_64KEY, KEY_WOW64_32KEY}) {
        HKEY uninstall = nullptr;
        if (RegOpenKeyExW(hive, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall", 0, KEY_READ | view, &uninstall) != ERROR_SUCCESS) continue;
        for (DWORD index = 0;; ++index) {
            wchar_t name[256]; DWORD length = _countof(name);
            if (RegEnumKeyExW(uninstall, index, name, &length, nullptr, nullptr, nullptr, nullptr) != ERROR_SUCCESS) break;
            HKEY app = nullptr;
            if (RegOpenKeyExW(uninstall, name, 0, KEY_READ | view, &app) != ERROR_SUCCESS) continue;
            auto display = RegistryText(app, L"DisplayName");
            std::transform(display.begin(), display.end(), display.begin(), towlower);
            if (display.find(L"razer") != std::wstring::npos) {
                ScanFolder(RegistryText(app, L"InstallLocation"));
                for (const auto* value : {L"DisplayIcon", L"UninstallString"}) {
                    auto command = RegistryText(app, value);
                    auto end = command.find(L".exe");
                    if (end == std::wstring::npos) continue;
                    auto start = command.front() == L'"' ? 1u : 0u;
                    ScanFolder(fs::path(command.substr(start, end + 4 - start)).parent_path());
                }
            }
            RegCloseKey(app);
        }
        RegCloseKey(uninstall);
    }
    for (const auto& id : {FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86, FOLDERID_LocalAppData}) ScanFolder(KnownFolder(id) / L"Razer/RazerAppEngine");
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
    payload = KnownFolder(FOLDERID_LocalAppData) / L"RazerTrayBatteryPatch/installer-1.6.1";
    fs::create_directories(payload / L"icons");
    ExtractResource(2000, payload / L"patch.cjs");
    ExtractResource(2001, payload / L"batteryTrayPatch.js");
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
    entries.erase(std::remove_if(entries.begin(), entries.end(), [](const auto& value) { return _wcsnicmp(value.c_str(), L"RAZER_PATCH_INSTALLER=", 22) == 0; }), entries.end());
    entries.push_back(L"RAZER_PATCH_INSTALLER=" + installer.wstring());
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

bool Probe() {
    engineVersion.clear();
    if (!IsEngine(engine)) return false;
    const auto result = RunNode(L"status");
    std::smatch match;
    if (result.code || !std::regex_search(result.output, match, std::regex("\"version\"\\s*:\\s*\"(4\\.[^\"]+)\""))) return false;
    engineVersion = Wide(match[1].str());
    return true;
}

void FindTargets() {
    Discover();
    std::vector<std::pair<fs::path, std::vector<unsigned long>>> supported;
    for (const auto& candidate : candidates) {
        engine = candidate;
        if (!Probe()) continue;
        std::vector<unsigned long> version;
        const auto text = engineVersion;
        const std::wregex digits(L"[0-9]+");
        for (auto it = std::wsregex_iterator(text.begin(), text.end(), digits); it != std::wsregex_iterator(); ++it) version.push_back(std::stoul(it->str()));
        supported.push_back({candidate, version});
    }
    std::stable_sort(supported.begin(), supported.end(), [](const auto& a, const auto& b) { return a.second > b.second; });
    candidates.clear();
    for (const auto& target : supported) candidates.push_back(target.first);
}

void UpdateSelection() {
    const auto index = SendMessageW(targetCombo, CB_GETCURSEL, 0, 0);
    engine = index >= 0 && static_cast<size_t>(index) < candidates.size() ? candidates[static_cast<size_t>(index)] : fs::path();
    const bool found = Probe();
    SetWindowTextW(versionLabel, found ? (L"已识别：Synapse " + engineVersion).c_str() : L"未识别到 Synapse 4 安装，请选择程序或安装文件夹。");
    SetWindowTextW(statusLabel, found ? L"应用或恢复时需要 Windows 授权，并会重启所选 Synapse。" : L"请选择包含 resources\\app.asar 的 RazerAppEngine.exe。" );
    EnableWindow(applyButton, found); EnableWindow(restoreButton, found);
}

void RefreshTargets() {
    SendMessageW(targetCombo, CB_RESETCONTENT, 0, 0);
    for (const auto& candidate : candidates) SendMessageW(targetCombo, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(candidate.c_str()));
    if (!candidates.empty()) SendMessageW(targetCombo, CB_SETCURSEL, 0, 0);
    UpdateSelection();
}

void ChooseTarget(bool folder) {
    IFileOpenDialog* dialog = nullptr;
    if (FAILED(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&dialog)))) return;
    DWORD options = 0; dialog->GetOptions(&options);
    dialog->SetOptions(options | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | (folder ? FOS_PICKFOLDERS : FOS_FILEMUSTEXIST));
    dialog->SetTitle(folder ? L"选择 Synapse 或 RazerAppEngine 安装文件夹" : L"选择 RazerAppEngine.exe");
    const COMDLG_FILTERSPEC filter[] = {{L"RazerAppEngine.exe", L"RazerAppEngine.exe"}};
    if (!folder) dialog->SetFileTypes(1, filter);
    if (SUCCEEDED(dialog->Show(mainWindow))) {
        IShellItem* item = nullptr;
        if (SUCCEEDED(dialog->GetResult(&item))) {
            PWSTR selected = nullptr;
            if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &selected))) {
                auto previous = candidates;
                candidates.clear();
                if (folder) ScanFolder(selected); else AddEngine(selected);
                if (candidates.empty()) {
                    candidates = previous;
                    MessageBoxW(mainWindow, L"此位置未找到 RazerAppEngine.exe 及其 resources\\app.asar，请选择 Synapse 的安装位置。", L"未找到程序", MB_OK | MB_ICONINFORMATION);
                } else {
                    const auto chosen = candidates;
                    candidates = previous;
                    for (const auto& candidate : chosen) AddEngine(candidate);
                    RefreshTargets();
                    const auto position = std::find(candidates.begin(), candidates.end(), chosen.front()) - candidates.begin();
                    SendMessageW(targetCombo, CB_SETCURSEL, position, 0);
                    UpdateSelection();
                }
                CoTaskMemFree(selected);
            }
            item->Release();
        }
    }
    dialog->Release();
}

Result Operate(const std::wstring& action) {
    const fs::path logPath = payload / L"patch-result.log";
    const auto before = fs::exists(logPath) ? fs::file_size(logPath) : 0;
    std::wstring arguments = L"--worker " + action + L" " + Quote(engine.wstring());
    SHELLEXECUTEINFOW shell{};
    shell.cbSize = sizeof(shell);
    shell.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC;
    shell.hwnd = mainWindow;
    shell.lpVerb = L"runas";
    shell.lpFile = installer.c_str();
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
        Control(L"STATIC", L"Razer Synapse 4  ·  补丁 1.6.1", 0, 26, 67, 630, 24);
        Control(L"STATIC", L"21 档电量圆环，40 像素原始图案。\r\n悬停显示实际电量，保留原来的点击和菜单。", 0, 26, 104, 470, 50);
        targetCombo = Control(L"COMBOBOX", L"", WS_TABSTOP | CBS_DROPDOWNLIST | WS_VSCROLL, 26, 169, 630, 180, SELECT);
        SendMessageW(targetCombo, CB_SETHORIZONTALEXTENT, Scale(1800), 0);
        fileButton = Control(L"BUTTON", L"选择程序…", WS_TABSTOP, 26, 210, 150, 34, FILE_PICK);
        folderButton = Control(L"BUTTON", L"选择文件夹…", WS_TABSTOP, 190, 210, 150, 34, FOLDER_PICK);
        scanButton = Control(L"BUTTON", L"重新检测", WS_TABSTOP, 354, 210, 142, 34, RESCAN);
        versionLabel = Control(L"STATIC", L"", 0, 26, 258, 630, 28);
        statusLabel = Control(L"STATIC", L"", 0, 26, 300, 630, 60);
        progressBar = Control(PROGRESS_CLASSW, L"", PBS_MARQUEE, 26, 370, 630, 6);
        ShowWindow(progressBar, SW_HIDE);
        applyButton = Control(L"BUTTON", L"应用补丁", WS_TABSTOP | BS_DEFPUSHBUTTON, 26, 396, 150, 40, APPLY);
        restoreButton = Control(L"BUTTON", L"恢复原版", WS_TABSTOP, 190, 396, 150, 40, RESTORE);
        closeButton = Control(L"BUTTON", L"关闭", WS_TABSTOP, 514, 396, 142, 40, CLOSE);
        RefreshTargets();
        return 0;
    }
    case WM_COMMAND: {
        const int id = LOWORD(wParam);
        if (busy) break;
        if (id == SELECT && HIWORD(wParam) == CBN_SELCHANGE) { UpdateSelection(); return 0; }
        if (id == FILE_PICK || id == FOLDER_PICK) { ChooseTarget(id == FOLDER_PICK); return 0; }
        if (id == RESCAN) { FindTargets(); RefreshTargets(); return 0; }
        if (id == CLOSE) { SendMessageW(window, WM_CLOSE, 0, 0); return 0; }
        if ((id != APPLY && id != RESTORE) || busy) break;
        busy = true;
        EnableWindow(applyButton, FALSE); EnableWindow(restoreButton, FALSE); EnableWindow(closeButton, FALSE);
        for (auto control : {targetCombo, fileButton, folderButton, scanButton}) EnableWindow(control, FALSE);
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
        for (auto control : {targetCombo, fileButton, folderButton, scanButton}) EnableWindow(control, TRUE);
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
        wchar_t executable[32768];
        GetModuleFileNameW(nullptr, executable, _countof(executable));
        installer = executable;
        Prepare();
        int argc = 0;
        LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
        if (argc == 4 && std::wstring(argv[1]) == L"--worker") {
            std::wstring action(argv[2]); engine = argv[3];
            if ((action != L"apply" && action != L"restore") || !Probe()) return 1;
            auto result = RunNode(action);
            std::ofstream log(payload / L"patch-result.log", std::ios::binary | std::ios::app);
            log << result.output;
            LocalFree(argv);
            return static_cast<int>(result.code);
        }
        FindTargets();
        engine = candidates.empty() ? fs::path() : candidates.front();
        if ((argc == 3 || argc == 4) && std::wstring(argv[1]) == L"--self-test") {
            if (argc == 4) engine = argv[3];
            if (!Probe()) return 1;
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
    RECT size{0, 0, Scale(682), Scale(460)};
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
