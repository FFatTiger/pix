#include <node_api.h>
#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#endif
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#ifndef PIPE_REJECT_REMOTE_CLIENTS
#define PIPE_REJECT_REMOTE_CLIENTS 0x00000008
#endif

#define PIX_NATIVE_API_VERSION 7
#define PIX_MAX_REPORTED_ACES 32
#define PIX_LISTENER_MAGIC 0x50584C31u

static napi_value throw_fixed(napi_env env, const char* code, const char* message) {
  napi_value error;
  napi_value text;
  napi_value code_value;
  if (napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text) != napi_ok) {
    napi_throw_error(env, "NATIVE_INTERNAL", "native operation failed");
    return NULL;
  }
  if (napi_create_error(env, NULL, text, &error) != napi_ok) {
    napi_throw_error(env, "NATIVE_INTERNAL", "native operation failed");
    return NULL;
  }
  if (napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) == napi_ok) {
    napi_set_named_property(env, error, "code", code_value);
  }
  napi_throw(env, error);
  return NULL;
}

static char* utf8_copy(napi_env env, napi_value value, size_t* out_length) {
  size_t length = 0;
  if (out_length) *out_length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length == 0 || length > 32767) {
    return NULL;
  }
  char* text = (char*)calloc(length + 1, 1);
  if (!text) return NULL;
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, text, length + 1, &written) != napi_ok || written != length) {
    free(text);
    return NULL;
  }
  /* JS strings may contain U+0000. A C-string conversion would silently
     truncate and open a different path, so reject before any Win32 call. */
  if (memchr(text, '\0', written) != NULL) {
    free(text);
    return NULL;
  }
  if (out_length) *out_length = written;
  return text;
}

static wchar_t* utf8_to_wide(const char* text, size_t utf8_length) {
  if (text == NULL || utf8_length == 0 || utf8_length > 32767) return NULL;
  if (memchr(text, '\0', utf8_length) != NULL) return NULL;
  int needed = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, (int)utf8_length, NULL, 0);
  if (needed <= 0) return NULL;
  wchar_t* wide = (wchar_t*)calloc((size_t)needed + 1, sizeof(wchar_t));
  if (!wide) return NULL;
  int converted = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, (int)utf8_length, wide, needed);
  if (converted != needed) {
    free(wide);
    return NULL;
  }
  return wide;
}

static wchar_t* wide_path_from_js(napi_env env, napi_value value) {
  napi_valuetype value_type = napi_undefined;
  if (napi_typeof(env, value, &value_type) != napi_ok || value_type != napi_string) return NULL;
  size_t utf8_length = 0;
  char* utf8 = utf8_copy(env, value, &utf8_length);
  if (!utf8) return NULL;
  wchar_t* path = utf8_to_wide(utf8, utf8_length);
  free(utf8);
  return path;
}

static napi_status set_utf8(napi_env env, napi_value object, const char* name, const char* text) {
  napi_value value;
  napi_status status = napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value);
  if (status != napi_ok) return status;
  return napi_set_named_property(env, object, name, value);
}

static napi_status set_bool(napi_env env, napi_value object, const char* name, int value) {
  napi_value result;
  napi_status status = napi_get_boolean(env, value ? 1 : 0, &result);
  if (status != napi_ok) return status;
  return napi_set_named_property(env, object, name, result);
}

static napi_status set_uint32(napi_env env, napi_value object, const char* name, uint32_t value) {
  napi_value result;
  napi_status status = napi_create_uint32(env, value, &result);
  if (status != napi_ok) return status;
  return napi_set_named_property(env, object, name, result);
}

static napi_status set_u64_decimal(napi_env env, napi_value object, const char* name, ULONGLONG value) {
  char digits[20];
  char buffer[21];
  size_t count = 0;
  ULONGLONG remaining = value;
  do {
    digits[count++] = (char)('0' + (remaining % 10));
    remaining /= 10;
  } while (remaining != 0 && count < sizeof(digits));
  if (remaining != 0) return napi_generic_failure;
  for (size_t i = 0; i < count; i++) {
    buffer[i] = digits[count - 1 - i];
  }
  buffer[count] = '\0';
  return set_utf8(env, object, name, buffer);
}

static napi_status set_hex_bytes(
  napi_env env,
  napi_value object,
  const char* name,
  const BYTE* bytes,
  size_t length
) {
  static const char digits[] = "0123456789abcdef";
  char buffer[65];
  if (length == 0 || length > 32) return napi_generic_failure;
  for (size_t i = 0; i < length; i++) {
    buffer[i * 2] = digits[(bytes[i] >> 4) & 0x0f];
    buffer[(i * 2) + 1] = digits[bytes[i] & 0x0f];
  }
  buffer[length * 2] = '\0';
  return set_utf8(env, object, name, buffer);
}

static napi_status set_acl_aces(napi_env env, napi_value object, PACL dacl, BOOL dacl_present) {
  napi_value aces;
  if (napi_create_array(env, &aces) != napi_ok) return napi_generic_failure;
  if (!dacl_present || dacl == NULL) {
    return napi_set_named_property(env, object, "aces", aces);
  }

  ACL_SIZE_INFORMATION info;
  ZeroMemory(&info, sizeof(info));
  if (!GetAclInformation(dacl, &info, sizeof(info), AclSizeInformation)) {
    return napi_generic_failure;
  }
  if (info.AceCount > PIX_MAX_REPORTED_ACES) {
    return napi_generic_failure;
  }

  uint32_t written = 0;
  for (DWORD i = 0; i < info.AceCount; i++) {
    void* ace_ptr = NULL;
    if (!GetAce(dacl, i, &ace_ptr) || ace_ptr == NULL) return napi_generic_failure;
    ACE_HEADER* header = (ACE_HEADER*)ace_ptr;
    PSID sid = NULL;
    DWORD mask = 0;
    const char* type = "other";
    if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
      ACCESS_ALLOWED_ACE* ace = (ACCESS_ALLOWED_ACE*)ace_ptr;
      sid = (PSID)&ace->SidStart;
      mask = ace->Mask;
      type = "allow";
    } else if (header->AceType == ACCESS_DENIED_ACE_TYPE) {
      ACCESS_DENIED_ACE* ace = (ACCESS_DENIED_ACE*)ace_ptr;
      sid = (PSID)&ace->SidStart;
      mask = ace->Mask;
      type = "deny";
    }

    napi_value entry;
    if (napi_create_object(env, &entry) != napi_ok) return napi_generic_failure;
    if (set_utf8(env, entry, "type", type) != napi_ok) return napi_generic_failure;
    if (set_uint32(env, entry, "mask", mask) != napi_ok) return napi_generic_failure;
    if (set_uint32(env, entry, "flags", header->AceFlags) != napi_ok) return napi_generic_failure;
    if (set_bool(env, entry, "inherited", (header->AceFlags & INHERITED_ACE) != 0) != napi_ok) {
      return napi_generic_failure;
    }
    if (sid != NULL && IsValidSid(sid)) {
      LPSTR sid_text = NULL;
      if (!ConvertSidToStringSidA(sid, &sid_text) || sid_text == NULL || sid_text[0] == '\0') {
        return napi_generic_failure;
      }
      napi_status status = set_utf8(env, entry, "sid", sid_text);
      LocalFree(sid_text);
      if (status != napi_ok) return status;
    } else if (set_utf8(env, entry, "sid", "") != napi_ok) {
      return napi_generic_failure;
    }
    if (napi_set_element(env, aces, written, entry) != napi_ok) return napi_generic_failure;
    written += 1;
  }
  return napi_set_named_property(env, object, "aces", aces);
}

static PSID copy_current_user_sid(void) {
  HANDLE token = NULL;
  DWORD length = 0;
  TOKEN_USER* user = NULL;
  PSID copy = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return NULL;
  GetTokenInformation(token, TokenUser, NULL, 0, &length);
  if (length == 0) {
    CloseHandle(token);
    return NULL;
  }
  user = (TOKEN_USER*)calloc(length, 1);
  if (!user || !GetTokenInformation(token, TokenUser, user, length, &length) || !IsValidSid(user->User.Sid)) {
    free(user);
    CloseHandle(token);
    return NULL;
  }
  DWORD sid_length = GetLengthSid(user->User.Sid);
  copy = (PSID)calloc(sid_length, 1);
  if (!copy || !CopySid(sid_length, copy, user->User.Sid)) {
    free(copy);
    copy = NULL;
  }
  free(user);
  CloseHandle(token);
  return copy;
}

static PSID create_local_system_sid(void) {
  SID_IDENTIFIER_AUTHORITY authority = SECURITY_NT_AUTHORITY;
  PSID sid = NULL;
  if (!AllocateAndInitializeSid(&authority, 1, SECURITY_LOCAL_SYSTEM_RID, 0, 0, 0, 0, 0, 0, 0, &sid)) {
    return NULL;
  }
  return sid;
}

static napi_value current_user_sid(napi_env env, napi_callback_info info) {
  (void)info;
  HANDLE token = NULL;
  DWORD length = 0;
  TOKEN_USER* user = NULL;
  LPSTR sid_text = NULL;
  napi_value result = NULL;

  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    return throw_fixed(env, "NATIVE_ACCESS_DENIED", "current user identity is unavailable");
  }
  GetTokenInformation(token, TokenUser, NULL, 0, &length);
  if (length == 0) goto fail;
  user = (TOKEN_USER*)calloc(length, 1);
  if (!user || !GetTokenInformation(token, TokenUser, user, length, &length) || !IsValidSid(user->User.Sid)) {
    goto fail;
  }
  if (!ConvertSidToStringSidA(user->User.Sid, &sid_text) || sid_text == NULL || sid_text[0] == '\0') {
    goto fail;
  }
  if (napi_create_string_utf8(env, sid_text, NAPI_AUTO_LENGTH, &result) != napi_ok) {
    LocalFree(sid_text);
    free(user);
    CloseHandle(token);
    return throw_fixed(env, "NATIVE_INTERNAL", "current user identity could not be inspected");
  }
  LocalFree(sid_text);
  free(user);
  CloseHandle(token);
  return result;

fail:
  if (sid_text) LocalFree(sid_text);
  if (user) free(user);
  if (token) CloseHandle(token);
  return throw_fixed(env, "NATIVE_INTERNAL", "current user identity could not be inspected");
}

static napi_value inspect_process(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int64_t pid_js = 0;
  HANDLE process = NULL;
  FILETIME creation;
  FILETIME exit_time;
  FILETIME kernel;
  FILETIME user;
  ULARGE_INTEGER ticks;
  char text[32];
  napi_value result = NULL;
  napi_value creation_value = NULL;

  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "pid is required");
  }
  if (napi_get_value_int64(env, argv[0], &pid_js) != napi_ok || pid_js <= 0 || pid_js > 0x7fffffff) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "pid is invalid");
  }
  process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)pid_js);
  if (!process) {
    DWORD error = GetLastError();
    if (error == ERROR_INVALID_PARAMETER || error == ERROR_INVALID_HANDLE) {
      napi_value missing;
      if (napi_get_null(env, &missing) != napi_ok) {
        return throw_fixed(env, "NATIVE_INTERNAL", "process identity could not be inspected");
      }
      return missing;
    }
    return throw_fixed(env, "NATIVE_ACCESS_DENIED", "process identity is unavailable");
  }
  if (!GetProcessTimes(process, &creation, &exit_time, &kernel, &user)) {
    CloseHandle(process);
    return throw_fixed(env, "NATIVE_INTERNAL", "process identity could not be inspected");
  }
  CloseHandle(process);
  ticks.LowPart = creation.dwLowDateTime;
  ticks.HighPart = creation.dwHighDateTime;
  if (snprintf(text, sizeof(text), "%llu", (unsigned long long)ticks.QuadPart) <= 0) {
    return throw_fixed(env, "NATIVE_INTERNAL", "process identity could not be inspected");
  }
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &creation_value) != napi_ok ||
      napi_set_named_property(env, result, "creationTime", creation_value) != napi_ok) {
    return throw_fixed(env, "NATIVE_INTERNAL", "process identity could not be inspected");
  }
  return result;
}

static napi_value inspect_path(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  wchar_t* path = NULL;
  HANDLE handle = INVALID_HANDLE_VALUE;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  LPSTR owner_text = NULL;
  napi_value result = NULL;
  napi_status status;

  status = napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (status != napi_ok || argc != 1) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "path is required");
  }
  path = wide_path_from_js(env, argv[0]);
  if (!path) return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "path is invalid");

  handle = CreateFileW(
    path,
    FILE_READ_ATTRIBUTES | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL,
    OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
    NULL
  );
  free(path);
  path = NULL;
  if (handle == INVALID_HANDLE_VALUE) {
    DWORD error = GetLastError();
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
      napi_value null_value;
      if (napi_get_null(env, &null_value) != napi_ok) {
        return throw_fixed(env, "NATIVE_INTERNAL", "native operation failed");
      }
      return null_value;
    }
    return throw_fixed(
      env,
      error == ERROR_ACCESS_DENIED ? "NATIVE_ACCESS_DENIED" : "NATIVE_INSPECT_FAILED",
      "path could not be inspected"
    );
  }

  FILE_ID_INFO file_id;
  FILE_ATTRIBUTE_TAG_INFO tag_info;
  BY_HANDLE_FILE_INFORMATION basic;
  ZeroMemory(&file_id, sizeof(file_id));
  ZeroMemory(&tag_info, sizeof(tag_info));
  ZeroMemory(&basic, sizeof(basic));
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &file_id, sizeof(file_id)) ||
      !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag_info, sizeof(tag_info)) ||
      !GetFileInformationByHandle(handle, &basic)) {
    CloseHandle(handle);
    return throw_fixed(env, "NATIVE_INSPECT_FAILED", "path identity could not be inspected");
  }

  PSID owner = NULL;
  DWORD security_result = GetSecurityInfo(
    handle,
    SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner,
    NULL,
    NULL,
    NULL,
    &descriptor
  );
  if (security_result != ERROR_SUCCESS) {
    CloseHandle(handle);
    return throw_fixed(
      env,
      security_result == ERROR_ACCESS_DENIED ? "NATIVE_ACCESS_DENIED" : "NATIVE_INSPECT_FAILED",
      "path security could not be inspected"
    );
  }

  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  BOOL dacl_present = FALSE;
  BOOL dacl_defaulted = FALSE;
  PACL descriptor_dacl = NULL;
  if (!GetSecurityDescriptorControl(descriptor, &control, &revision) ||
      !GetSecurityDescriptorDacl(descriptor, &dacl_present, &descriptor_dacl, &dacl_defaulted) ||
      owner == NULL ||
      !IsValidSid(owner) ||
      !ConvertSidToStringSidA(owner, &owner_text) ||
      owner_text == NULL ||
      owner_text[0] == '\0') {
    if (owner_text) LocalFree(owner_text);
    LocalFree(descriptor);
    CloseHandle(handle);
    return throw_fixed(env, "NATIVE_INSPECT_FAILED", "path security could not be inspected");
  }

  if (napi_create_object(env, &result) != napi_ok ||
      set_u64_decimal(env, result, "volumeSerial", file_id.VolumeSerialNumber) != napi_ok ||
      set_hex_bytes(env, result, "fileId", file_id.FileId.Identifier, sizeof(file_id.FileId.Identifier)) != napi_ok ||
      set_u64_decimal(
        env,
        result,
        "size",
        (((ULONGLONG)basic.nFileSizeHigh) << 32) | basic.nFileSizeLow
      ) != napi_ok ||
      set_uint32(env, result, "attributes", tag_info.FileAttributes) != napi_ok ||
      set_uint32(env, result, "reparseTag", tag_info.ReparseTag) != napi_ok ||
      set_bool(env, result, "isReparsePoint", (tag_info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) != napi_ok ||
      set_bool(env, result, "isDirectory", (tag_info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != napi_ok ||
      set_bool(env, result, "isFile", (tag_info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) != napi_ok ||
      set_utf8(env, result, "ownerSid", owner_text) != napi_ok ||
      set_bool(env, result, "daclPresent", dacl_present != FALSE) != napi_ok ||
      set_bool(env, result, "daclProtected", (control & SE_DACL_PROTECTED) != 0) != napi_ok ||
      set_acl_aces(env, result, descriptor_dacl, dacl_present) != napi_ok) {
    LocalFree(owner_text);
    LocalFree(descriptor);
    CloseHandle(handle);
    return throw_fixed(env, "NATIVE_INTERNAL", "native operation failed");
  }

  LocalFree(owner_text);
  LocalFree(descriptor);
  CloseHandle(handle);
  return result;
}

static void free_explicit_acl(PACL acl) {
  if (acl) LocalFree(acl);
}

static int is_named_pipe_path(const wchar_t* path) {
  if (path == NULL) return 0;
  return (wcsncmp(path, L"\\\\.\\pipe\\", 9) == 0 || wcsncmp(path, L"\\\\?\\pipe\\", 9) == 0)
    && path[9] != L'\0';
}

static PACL create_private_allowlist_acl(PSID user_sid, PSID system_sid) {
  EXPLICIT_ACCESS_W access[2];
  PACL acl = NULL;
  ZeroMemory(access, sizeof(access));
  access[0].grfAccessPermissions = GENERIC_ALL;
  access[0].grfAccessMode = SET_ACCESS;
  access[0].grfInheritance = NO_INHERITANCE;
  access[0].Trustee.TrusteeForm = TRUSTEE_IS_SID;
  access[0].Trustee.TrusteeType = TRUSTEE_IS_USER;
  access[0].Trustee.ptstrName = (LPWSTR)user_sid;
  access[1].grfAccessPermissions = GENERIC_ALL;
  access[1].grfAccessMode = SET_ACCESS;
  access[1].grfInheritance = NO_INHERITANCE;
  access[1].Trustee.TrusteeForm = TRUSTEE_IS_SID;
  access[1].Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
  access[1].Trustee.ptstrName = (LPWSTR)system_sid;
  if (SetEntriesInAclW(2, access, NULL, &acl) != ERROR_SUCCESS) return NULL;
  return acl;
}

typedef struct {
  PSID user_sid;
  PSID system_sid;
  PACL acl;
  SECURITY_DESCRIPTOR descriptor;
  SECURITY_ATTRIBUTES attributes;
} pix_pipe_security;

static void free_pipe_security(pix_pipe_security* security) {
  if (!security) return;
  if (security->acl) free_explicit_acl(security->acl);
  if (security->user_sid) free(security->user_sid);
  if (security->system_sid) FreeSid(security->system_sid);
  ZeroMemory(security, sizeof(*security));
}

static int init_pipe_security(pix_pipe_security* security) {
  ZeroMemory(security, sizeof(*security));
  security->user_sid = copy_current_user_sid();
  security->system_sid = create_local_system_sid();
  if (!security->user_sid || !security->system_sid) {
    free_pipe_security(security);
    return 0;
  }
  security->acl = create_private_allowlist_acl(security->user_sid, security->system_sid);
  if (security->acl == NULL ||
      !InitializeSecurityDescriptor(&security->descriptor, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorOwner(&security->descriptor, security->user_sid, FALSE) ||
      !SetSecurityDescriptorDacl(&security->descriptor, TRUE, security->acl, FALSE) ||
      !SetSecurityDescriptorControl(&security->descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) {
    free_pipe_security(security);
    return 0;
  }
  security->attributes.nLength = sizeof(security->attributes);
  security->attributes.lpSecurityDescriptor = &security->descriptor;
  security->attributes.bInheritHandle = FALSE;
  return 1;
}

static HANDLE create_named_pipe_instance(const wchar_t* path, DWORD extra_access, SECURITY_ATTRIBUTES* attributes) {
  return CreateNamedPipeW(
    path,
    PIPE_ACCESS_DUPLEX | extra_access,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_UNLIMITED_INSTANCES,
    65536,
    65536,
    0,
    attributes
  );
}

typedef struct {
  uint32_t magic;
  wchar_t* path;
  HANDLE pending;
  HANDLE stop_event;
  HANDLE ready_event;
  HANDLE thread;
  napi_threadsafe_function tsfn;
  volatile LONG stopping;
  DWORD first_error;
} pix_pipe_listener;

static void close_pipe_handle(HANDLE* handle) {
  if (handle && *handle && *handle != INVALID_HANDLE_VALUE) {
    CloseHandle(*handle);
    *handle = INVALID_HANDLE_VALUE;
  }
}

static void destroy_pipe_listener(pix_pipe_listener* listener) {
  if (!listener) return;
  listener->magic = 0;
  if (listener->tsfn) {
    napi_release_threadsafe_function(listener->tsfn, napi_tsfn_abort);
    listener->tsfn = NULL;
  }
  close_pipe_handle(&listener->pending);
  close_pipe_handle(&listener->stop_event);
  close_pipe_handle(&listener->ready_event);
  close_pipe_handle(&listener->thread);
  if (listener->path) {
    free(listener->path);
    listener->path = NULL;
  }
  free(listener);
}

static napi_status set_security_evidence(
  napi_env env,
  napi_value result,
  PSID owner,
  PACL dacl,
  BOOL dacl_present,
  SECURITY_DESCRIPTOR_CONTROL control
) {
  LPSTR owner_text = NULL;
  if (owner == NULL || !IsValidSid(owner) || !ConvertSidToStringSidA(owner, &owner_text) || owner_text == NULL || owner_text[0] == '\0') {
    return napi_generic_failure;
  }
  napi_status status = set_utf8(env, result, "ownerSid", owner_text);
  LocalFree(owner_text);
  if (status != napi_ok) return status;
  if (set_bool(env, result, "daclPresent", dacl_present != FALSE) != napi_ok) return napi_generic_failure;
  if (set_bool(env, result, "daclProtected", (control & SE_DACL_PROTECTED) != 0) != napi_ok) return napi_generic_failure;
  return set_acl_aces(env, result, dacl, dacl_present);
}

static napi_value create_private_object(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  wchar_t* path = NULL;
  char* kind = NULL;
  size_t kind_length = 0;
  PSID user_sid = NULL;
  PSID system_sid = NULL;
  PACL acl = NULL;
  SECURITY_DESCRIPTOR descriptor;
  int is_directory = 0;

  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "path and kind are required");
  }
  path = wide_path_from_js(env, argv[0]);
  if (!path) return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "path is invalid");
  kind = utf8_copy(env, argv[1], &kind_length);
  if (!kind) {
    free(path);
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "kind is invalid");
  }
  if (strcmp(kind, "directory") == 0) {
    is_directory = 1;
  } else if (strcmp(kind, "file") != 0) {
    free(kind);
    free(path);
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "kind is invalid");
  }
  free(kind);

  user_sid = copy_current_user_sid();
  system_sid = create_local_system_sid();
  if (!user_sid || !system_sid) {
    if (user_sid) free(user_sid);
    if (system_sid) FreeSid(system_sid);
    free(path);
    return throw_fixed(env, "NATIVE_INTERNAL", "current user identity could not be inspected");
  }

  EXPLICIT_ACCESS_W access[2];
  ZeroMemory(access, sizeof(access));
  DWORD inheritance = is_directory ? (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) : NO_INHERITANCE;
  access[0].grfAccessPermissions = GENERIC_ALL;
  access[0].grfAccessMode = SET_ACCESS;
  access[0].grfInheritance = inheritance;
  access[0].Trustee.TrusteeForm = TRUSTEE_IS_SID;
  access[0].Trustee.TrusteeType = TRUSTEE_IS_USER;
  access[0].Trustee.ptstrName = (LPWSTR)user_sid;
  access[1].grfAccessPermissions = GENERIC_ALL;
  access[1].grfAccessMode = SET_ACCESS;
  access[1].grfInheritance = inheritance;
  access[1].Trustee.TrusteeForm = TRUSTEE_IS_SID;
  access[1].Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
  access[1].Trustee.ptstrName = (LPWSTR)system_sid;

  if (SetEntriesInAclW(2, access, NULL, &acl) != ERROR_SUCCESS || acl == NULL) {
    free(user_sid);
    FreeSid(system_sid);
    free(path);
    return throw_fixed(env, "NATIVE_INTERNAL", "private security descriptor could not be created");
  }
  if (!InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorOwner(&descriptor, user_sid, FALSE) ||
      !SetSecurityDescriptorDacl(&descriptor, TRUE, acl, FALSE) ||
      !SetSecurityDescriptorControl(&descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) {
    free_explicit_acl(acl);
    free(user_sid);
    FreeSid(system_sid);
    free(path);
    return throw_fixed(env, "NATIVE_INTERNAL", "private security descriptor could not be created");
  }

  SECURITY_ATTRIBUTES attributes;
  ZeroMemory(&attributes, sizeof(attributes));
  attributes.nLength = sizeof(attributes);
  attributes.lpSecurityDescriptor = &descriptor;
  attributes.bInheritHandle = FALSE;

  BOOL created = FALSE;
  DWORD error = 0;
  if (is_directory) {
    created = CreateDirectoryW(path, &attributes);
    error = created ? 0 : GetLastError();
  } else {
    HANDLE handle = CreateFileW(
      path,
      GENERIC_READ | GENERIC_WRITE,
      0,
      &attributes,
      CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL,
      NULL
    );
    if (handle != INVALID_HANDLE_VALUE) {
      created = TRUE;
      CloseHandle(handle);
    } else {
      error = GetLastError();
    }
  }

  free_explicit_acl(acl);
  free(user_sid);
  FreeSid(system_sid);
  free(path);

  if (!created) {
    if (error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS) {
      return throw_fixed(env, "NATIVE_ALREADY_EXISTS", "path already exists");
    }
    if (error == ERROR_PATH_NOT_FOUND || error == ERROR_FILE_NOT_FOUND) {
      return throw_fixed(env, "NATIVE_NOT_FOUND", "parent path does not exist");
    }
    return throw_fixed(
      env,
      error == ERROR_ACCESS_DENIED ? "NATIVE_ACCESS_DENIED" : "NATIVE_CREATE_FAILED",
      "private object could not be created"
    );
  }

  napi_value result;
  if (napi_get_boolean(env, 1, &result) != napi_ok) {
    return throw_fixed(env, "NATIVE_INTERNAL", "native operation failed");
  }
  return result;
}

static napi_value create_exclusive_private_file(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  wchar_t* path = NULL;
  void* source = NULL;
  size_t length = 0;
  bool is_buffer = FALSE;
  PSID user_sid = NULL;
  PSID system_sid = NULL;
  PACL acl = NULL;
  SECURITY_DESCRIPTOR descriptor;
  HANDLE handle = INVALID_HANDLE_VALUE;

  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "path and bytes are required");
  }
  path = wide_path_from_js(env, argv[0]);
  if (!path) return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "path is invalid");
  if (napi_is_buffer(env, argv[1], &is_buffer) != napi_ok || !is_buffer ||
      napi_get_buffer_info(env, argv[1], &source, &length) != napi_ok) {
    free(path);
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "bytes are invalid");
  }
  if (length > 65536) {
    free(path);
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "bytes are invalid");
  }

  user_sid = copy_current_user_sid();
  system_sid = create_local_system_sid();
  if (!user_sid || !system_sid) {
    if (user_sid) free(user_sid);
    if (system_sid) FreeSid(system_sid);
    free(path);
    return throw_fixed(env, "NATIVE_INTERNAL", "current user identity could not be inspected");
  }

  EXPLICIT_ACCESS_W access[2];
  ZeroMemory(access, sizeof(access));
  access[0].grfAccessPermissions = GENERIC_ALL;
  access[0].grfAccessMode = SET_ACCESS;
  access[0].grfInheritance = NO_INHERITANCE;
  access[0].Trustee.TrusteeForm = TRUSTEE_IS_SID;
  access[0].Trustee.TrusteeType = TRUSTEE_IS_USER;
  access[0].Trustee.ptstrName = (LPWSTR)user_sid;
  access[1].grfAccessPermissions = GENERIC_ALL;
  access[1].grfAccessMode = SET_ACCESS;
  access[1].grfInheritance = NO_INHERITANCE;
  access[1].Trustee.TrusteeForm = TRUSTEE_IS_SID;
  access[1].Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
  access[1].Trustee.ptstrName = (LPWSTR)system_sid;

  if (SetEntriesInAclW(2, access, NULL, &acl) != ERROR_SUCCESS || acl == NULL) {
    free(user_sid);
    FreeSid(system_sid);
    free(path);
    return throw_fixed(env, "NATIVE_INTERNAL", "private security descriptor could not be created");
  }
  if (!InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorOwner(&descriptor, user_sid, FALSE) ||
      !SetSecurityDescriptorDacl(&descriptor, TRUE, acl, FALSE) ||
      !SetSecurityDescriptorControl(&descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) {
    free_explicit_acl(acl);
    free(user_sid);
    FreeSid(system_sid);
    free(path);
    return throw_fixed(env, "NATIVE_INTERNAL", "private security descriptor could not be created");
  }

  SECURITY_ATTRIBUTES attributes;
  ZeroMemory(&attributes, sizeof(attributes));
  attributes.nLength = sizeof(attributes);
  attributes.lpSecurityDescriptor = &descriptor;
  attributes.bInheritHandle = FALSE;

  /* Same-handle exclusive publish: CREATE_NEW + write + flush before close.
     The final name is never visible as a zero-byte file (POSIX O_EXCL + write). */
  handle = CreateFileW(
    path,
    GENERIC_READ | GENERIC_WRITE,
    0,
    &attributes,
    CREATE_NEW,
    FILE_ATTRIBUTE_NORMAL,
    NULL
  );
  DWORD error = (handle == INVALID_HANDLE_VALUE) ? GetLastError() : 0;
  if (handle == INVALID_HANDLE_VALUE) {
    free_explicit_acl(acl);
    free(user_sid);
    FreeSid(system_sid);
    free(path);
    if (error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS) {
      return throw_fixed(env, "NATIVE_ALREADY_EXISTS", "path already exists");
    }
    if (error == ERROR_PATH_NOT_FOUND || error == ERROR_FILE_NOT_FOUND) {
      return throw_fixed(env, "NATIVE_NOT_FOUND", "parent path does not exist");
    }
    return throw_fixed(
      env,
      error == ERROR_ACCESS_DENIED ? "NATIVE_ACCESS_DENIED" : "NATIVE_CREATE_FAILED",
      "private object could not be created"
    );
  }

  DWORD transferred = 0;
  BOOL wrote = (length == 0) ? TRUE : WriteFile(handle, source, (DWORD)length, &transferred, NULL);
  if (!wrote || transferred != (DWORD)length || !FlushFileBuffers(handle)) {
    error = GetLastError();
    CloseHandle(handle);
    DeleteFileW(path);
    free_explicit_acl(acl);
    free(user_sid);
    FreeSid(system_sid);
    free(path);
    return throw_fixed(
      env,
      error == ERROR_ACCESS_DENIED ? "NATIVE_ACCESS_DENIED" : "NATIVE_CREATE_FAILED",
      "private object could not be created"
    );
  }
  CloseHandle(handle);
  free_explicit_acl(acl);
  free(user_sid);
  FreeSid(system_sid);
  free(path);

  napi_value result;
  if (napi_get_boolean(env, 1, &result) != napi_ok) {
    return throw_fixed(env, "NATIVE_INTERNAL", "native operation failed");
  }
  return result;
}

static napi_value inspect_named_pipe(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  wchar_t* path = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  napi_value result = NULL;

  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "path is required");
  }
  path = wide_path_from_js(env, argv[0]);
  if (!path || !is_named_pipe_path(path)) {
    if (path) free(path);
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "path is invalid");
  }

  PSID owner = NULL;
  PACL dacl = NULL;
  DWORD security_result = GetNamedSecurityInfoW(
    path,
    SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner,
    NULL,
    &dacl,
    NULL,
    &descriptor
  );
  free(path);
  if (security_result != ERROR_SUCCESS) {
    if (security_result == ERROR_FILE_NOT_FOUND || security_result == ERROR_PATH_NOT_FOUND) {
      napi_value null_value;
      if (napi_get_null(env, &null_value) != napi_ok) {
        return throw_fixed(env, "NATIVE_INTERNAL", "native operation failed");
      }
      return null_value;
    }
    return throw_fixed(
      env,
      security_result == ERROR_ACCESS_DENIED ? "NATIVE_ACCESS_DENIED" : "NATIVE_INSPECT_FAILED",
      "named pipe security could not be inspected"
    );
  }

  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  BOOL dacl_present = FALSE;
  BOOL dacl_defaulted = FALSE;
  PACL descriptor_dacl = NULL;
  if (!GetSecurityDescriptorControl(descriptor, &control, &revision) ||
      !GetSecurityDescriptorDacl(descriptor, &dacl_present, &descriptor_dacl, &dacl_defaulted)) {
    LocalFree(descriptor);
    return throw_fixed(env, "NATIVE_INSPECT_FAILED", "named pipe security could not be inspected");
  }

  if (napi_create_object(env, &result) != napi_ok ||
      set_security_evidence(env, result, owner, descriptor_dacl, dacl_present, control) != napi_ok) {
    LocalFree(descriptor);
    return throw_fixed(env, "NATIVE_INTERNAL", "native operation failed");
  }

  LocalFree(descriptor);
  return result;
}

static napi_value create_protected_named_pipe(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  wchar_t* path = NULL;
  pix_pipe_security security;
  HANDLE pipe = INVALID_HANDLE_VALUE;

  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "path is required");
  }
  path = wide_path_from_js(env, argv[0]);
  if (!path || !is_named_pipe_path(path)) {
    if (path) free(path);
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "path is invalid");
  }

  if (!init_pipe_security(&security)) {
    free(path);
    return throw_fixed(env, "NATIVE_INTERNAL", "private security descriptor could not be created");
  }
  pipe = create_named_pipe_instance(path, FILE_FLAG_FIRST_PIPE_INSTANCE, &security.attributes);
  {
    DWORD error = (pipe == INVALID_HANDLE_VALUE) ? GetLastError() : 0;
    free_pipe_security(&security);
    free(path);
    if (pipe == INVALID_HANDLE_VALUE) {
      if (error == ERROR_ACCESS_DENIED || error == ERROR_PIPE_BUSY) {
        return throw_fixed(env, "NATIVE_ALREADY_EXISTS", "named pipe already exists");
      }
      return throw_fixed(
        env,
        error == ERROR_INVALID_NAME ? "NATIVE_INVALID_ARGUMENT" : "NATIVE_CREATE_FAILED",
        "named pipe could not be created"
      );
    }
  }

  napi_value result;
  if (napi_create_bigint_uint64(env, (uint64_t)(uintptr_t)pipe, &result) != napi_ok) {
    CloseHandle(pipe);
    return throw_fixed(env, "NATIVE_INTERNAL", "native operation failed");
  }
  return result;
}

static napi_value inspect_named_pipe_handle(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  uint64_t raw = 0;
  bool lossless = false;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  napi_value result = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "handle is required");
  }
  if (napi_get_value_bigint_uint64(env, argv[0], &raw, &lossless) != napi_ok || !lossless || raw == 0) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "handle is invalid");
  }
  HANDLE pipe = (HANDLE)(uintptr_t)raw;
  PSID owner = NULL;
  PACL dacl = NULL;
  DWORD security_result = GetSecurityInfo(
    pipe,
    SE_KERNEL_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner,
    NULL,
    &dacl,
    NULL,
    &descriptor
  );
  if (security_result != ERROR_SUCCESS) {
    return throw_fixed(
      env,
      security_result == ERROR_ACCESS_DENIED ? "NATIVE_ACCESS_DENIED" : "NATIVE_INSPECT_FAILED",
      "named pipe security could not be inspected"
    );
  }
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  BOOL dacl_present = FALSE;
  BOOL dacl_defaulted = FALSE;
  PACL descriptor_dacl = NULL;
  if (!GetSecurityDescriptorControl(descriptor, &control, &revision) ||
      !GetSecurityDescriptorDacl(descriptor, &dacl_present, &descriptor_dacl, &dacl_defaulted)) {
    LocalFree(descriptor);
    return throw_fixed(env, "NATIVE_INSPECT_FAILED", "named pipe security could not be inspected");
  }
  if (napi_create_object(env, &result) != napi_ok ||
      set_security_evidence(env, result, owner, descriptor_dacl, dacl_present, control) != napi_ok) {
    LocalFree(descriptor);
    return throw_fixed(env, "NATIVE_INTERNAL", "native operation failed");
  }
  LocalFree(descriptor);
  return result;
}

static napi_value close_named_pipe_handle(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  uint64_t raw = 0;
  bool lossless = false;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "handle is required");
  }
  if (napi_get_value_bigint_uint64(env, argv[0], &raw, &lossless) != napi_ok || !lossless || raw == 0) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "handle is invalid");
  }
  HANDLE pipe = (HANDLE)(uintptr_t)raw;
  CancelIoEx(pipe, NULL);
  DisconnectNamedPipe(pipe);
  if (!CloseHandle(pipe)) {
    return throw_fixed(env, "NATIVE_INTERNAL", "named pipe handle could not be closed");
  }
  napi_value result;
  if (napi_get_boolean(env, 1, &result) != napi_ok) {
    return throw_fixed(env, "NATIVE_INTERNAL", "native operation failed");
  }
  return result;
}

static HANDLE handle_from_js(napi_env env, napi_value value) {
  uint64_t raw = 0;
  bool lossless = false;
  if (napi_get_value_bigint_uint64(env, value, &raw, &lossless) != napi_ok || !lossless || raw == 0) {
    return INVALID_HANDLE_VALUE;
  }
  HANDLE pipe = (HANDLE)(uintptr_t)raw;
  if (pipe == INVALID_HANDLE_VALUE) return INVALID_HANDLE_VALUE;
  return pipe;
}

typedef struct {
  HANDLE pipe;
  uint8_t* data;
  DWORD capacity;
  DWORD transferred;
  DWORD error;
  int is_write;
  napi_async_work work;
  napi_deferred deferred;
} pix_pipe_io;

static int is_pipe_closed_error(DWORD error) {
  return error == ERROR_BROKEN_PIPE
    || error == ERROR_NO_DATA
    || error == ERROR_PIPE_NOT_CONNECTED
    || error == ERROR_OPERATION_ABORTED
    || error == ERROR_INVALID_HANDLE;
}

static DWORD overlapped_transfer(HANDLE pipe, void* data, DWORD length, int is_write, DWORD* transferred) {
  OVERLAPPED overlapped;
  ZeroMemory(&overlapped, sizeof(overlapped));
  overlapped.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (overlapped.hEvent == NULL) return GetLastError();
  BOOL ok = is_write
    ? WriteFile(pipe, data, length, NULL, &overlapped)
    : ReadFile(pipe, data, length, NULL, &overlapped);
  DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  if (!ok && error == ERROR_IO_PENDING) {
    if (WaitForSingleObject(overlapped.hEvent, INFINITE) != WAIT_OBJECT_0) {
      error = GetLastError();
      CancelIoEx(pipe, &overlapped);
      WaitForSingleObject(overlapped.hEvent, 1000);
      CloseHandle(overlapped.hEvent);
      return error == ERROR_SUCCESS ? ERROR_OPERATION_ABORTED : error;
    }
    error = GetOverlappedResult(pipe, &overlapped, transferred, FALSE) ? ERROR_SUCCESS : GetLastError();
    CloseHandle(overlapped.hEvent);
    return error;
  }
  if (ok) {
    if (!GetOverlappedResult(pipe, &overlapped, transferred, FALSE)) {
      error = GetLastError();
    }
  }
  CloseHandle(overlapped.hEvent);
  return error;
}

static void pipe_io_execute(napi_env env, void* data) {
  pix_pipe_io* io = (pix_pipe_io*)data;
  (void)env;
  io->error = overlapped_transfer(io->pipe, io->data, io->capacity, io->is_write, &io->transferred);
}

static void pipe_io_complete(napi_env env, napi_status status, void* data) {
  pix_pipe_io* io = (pix_pipe_io*)data;
  napi_value result = NULL;
  napi_deferred deferred = io->deferred;
  DWORD error = io->error;
  DWORD transferred = io->transferred;
  int is_write = io->is_write;
  uint8_t* bytes = io->data;
  napi_delete_async_work(env, io->work);
  free(io);
  if (status != napi_ok) {
    napi_value text;
    napi_value rejection;
    if (napi_create_string_utf8(env, "named pipe I/O cancelled", NAPI_AUTO_LENGTH, &text) == napi_ok &&
        napi_create_error(env, NULL, text, &rejection) == napi_ok) {
      napi_reject_deferred(env, deferred, rejection);
    }
    free(bytes);
    return;
  }
  if (!is_write && is_pipe_closed_error(error)) {
    if (napi_create_buffer(env, 0, NULL, &result) == napi_ok) {
      napi_resolve_deferred(env, deferred, result);
    }
    free(bytes);
    return;
  }
  if (error != ERROR_SUCCESS) {
    napi_value text;
    napi_value code;
    napi_value err;
    if (napi_create_string_utf8(env, is_write ? "named pipe write failed" : "named pipe read failed", NAPI_AUTO_LENGTH, &text) == napi_ok &&
        napi_create_error(env, NULL, text, &err) == napi_ok &&
        napi_create_string_utf8(env, error == ERROR_ACCESS_DENIED ? "NATIVE_ACCESS_DENIED" : (is_pipe_closed_error(error) ? "NATIVE_PIPE_CLOSED" : "NATIVE_IO_FAILED"), NAPI_AUTO_LENGTH, &code) == napi_ok) {
      napi_set_named_property(env, err, "code", code);
      napi_reject_deferred(env, deferred, err);
    }
    free(bytes);
    return;
  }
  if (is_write) {
    if (napi_create_uint32(env, transferred, &result) == napi_ok) {
      napi_resolve_deferred(env, deferred, result);
    }
    free(bytes);
    return;
  }
  if (napi_create_buffer_copy(env, transferred, bytes, NULL, &result) == napi_ok) {
    napi_resolve_deferred(env, deferred, result);
  }
  free(bytes);
}

static napi_value queue_pipe_io(napi_env env, HANDLE pipe, uint8_t* data, DWORD capacity, int is_write) {
  pix_pipe_io* io = (pix_pipe_io*)calloc(1, sizeof(*io));
  napi_value resource_name;
  napi_value promise;
  if (io == NULL) {
    free(data);
    return throw_fixed(env, "NATIVE_INTERNAL", "native operation failed");
  }
  io->pipe = pipe;
  io->data = data;
  io->capacity = capacity;
  io->is_write = is_write;
  if (napi_create_string_utf8(env, "pix-named-pipe-io", NAPI_AUTO_LENGTH, &resource_name) != napi_ok ||
      napi_create_promise(env, &io->deferred, &promise) != napi_ok ||
      napi_create_async_work(env, NULL, resource_name, pipe_io_execute, pipe_io_complete, io, &io->work) != napi_ok ||
      napi_queue_async_work(env, io->work) != napi_ok) {
    if (io->deferred) {
      napi_value text;
      napi_value err;
      if (napi_create_string_utf8(env, "named pipe I/O could not be queued", NAPI_AUTO_LENGTH, &text) == napi_ok &&
          napi_create_error(env, NULL, text, &err) == napi_ok) {
        napi_reject_deferred(env, io->deferred, err);
      }
    }
    free(data);
    free(io);
    return throw_fixed(env, "NATIVE_INTERNAL", "native operation failed");
  }
  return promise;
}

static napi_value read_named_pipe_handle(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  uint32_t max_bytes = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "handle and maxBytes are required");
  }
  HANDLE pipe = handle_from_js(env, argv[0]);
  if (pipe == INVALID_HANDLE_VALUE) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "handle is invalid");
  }
  if (napi_get_value_uint32(env, argv[1], &max_bytes) != napi_ok || max_bytes == 0 || max_bytes > 65536) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "maxBytes is invalid");
  }
  uint8_t* data = (uint8_t*)malloc(max_bytes);
  if (data == NULL) {
    return throw_fixed(env, "NATIVE_INTERNAL", "native operation failed");
  }
  return queue_pipe_io(env, pipe, data, max_bytes, 0);
}

static napi_value write_named_pipe_handle(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "handle and bytes are required");
  }
  HANDLE pipe = handle_from_js(env, argv[0]);
  if (pipe == INVALID_HANDLE_VALUE) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "handle is invalid");
  }
  void* source = NULL;
  size_t length = 0;
  bool is_buffer = false;
  if (napi_is_buffer(env, argv[1], &is_buffer) != napi_ok || !is_buffer ||
      napi_get_buffer_info(env, argv[1], &source, &length) != napi_ok) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "bytes are invalid");
  }
  if (length > 65536) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "bytes are invalid");
  }
  uint8_t* data = NULL;
  if (length > 0) {
    data = (uint8_t*)malloc(length);
    if (data == NULL) {
      return throw_fixed(env, "NATIVE_INTERNAL", "native operation failed");
    }
    memcpy(data, source, length);
  }
  return queue_pipe_io(env, pipe, data, (DWORD)length, 1);
}

static void listener_js_cb(napi_env env, napi_value js_cb, void* context, void* data) {
  uint64_t* payload = (uint64_t*)data;
  (void)context;
  if (payload == NULL) return;
  HANDLE accepted = (HANDLE)(uintptr_t)(*payload);
  if (env == NULL || js_cb == NULL) {
    if (accepted && accepted != INVALID_HANDLE_VALUE) CloseHandle(accepted);
    free(payload);
    return;
  }
  napi_value undefined;
  napi_value handle_value;
  napi_value result;
  if (napi_get_undefined(env, &undefined) != napi_ok ||
      napi_create_bigint_uint64(env, *payload, &handle_value) != napi_ok ||
      napi_call_function(env, undefined, js_cb, 1, &handle_value, &result) != napi_ok) {
    if (accepted && accepted != INVALID_HANDLE_VALUE) CloseHandle(accepted);
  }
  free(payload);
}

static DWORD WINAPI pipe_listener_thread(LPVOID raw) {
  pix_pipe_listener* listener = (pix_pipe_listener*)raw;
  HANDLE wait_handles[2];
  int signaled_ready = 0;
  wait_handles[1] = listener->stop_event;
  while (InterlockedCompareExchange(&listener->stopping, 0, 0) == 0) {
    OVERLAPPED overlapped;
    ZeroMemory(&overlapped, sizeof(overlapped));
    overlapped.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (overlapped.hEvent == NULL) {
      listener->first_error = GetLastError();
      break;
    }
    BOOL connected = ConnectNamedPipe(listener->pending, &overlapped);
    DWORD error = connected ? ERROR_SUCCESS : GetLastError();
    // `CreateNamedPipeW` alone makes a client endpoint visible, but the
    // listener is not actually ready until its first ConnectNamedPipe is
    // armed. Signal exactly once so the JS bind operation cannot report
    // success during that startup window. A synchronous startup failure is
    // reported below before signalling, so the waiting JS caller sees it.
    if (!signaled_ready && (connected || error == ERROR_IO_PENDING || error == ERROR_PIPE_CONNECTED) && listener->ready_event) {
      SetEvent(listener->ready_event);
      signaled_ready = 1;
    }
    if (!connected && error == ERROR_IO_PENDING) {
      wait_handles[0] = overlapped.hEvent;
      DWORD wait = WaitForMultipleObjects(2, wait_handles, FALSE, INFINITE);
      if (wait != WAIT_OBJECT_0) {
        CancelIoEx(listener->pending, &overlapped);
        WaitForSingleObject(overlapped.hEvent, 1000);
        CloseHandle(overlapped.hEvent);
        break;
      }
      DWORD transferred = 0;
      if (!GetOverlappedResult(listener->pending, &overlapped, &transferred, FALSE)) {
        error = GetLastError();
        CloseHandle(overlapped.hEvent);
        if (InterlockedCompareExchange(&listener->stopping, 0, 0) != 0) break;
        listener->first_error = error;
        break;
      }
    } else if (!connected && error != ERROR_PIPE_CONNECTED) {
      CloseHandle(overlapped.hEvent);
      if (InterlockedCompareExchange(&listener->stopping, 0, 0) != 0) break;
      listener->first_error = error;
      if (!signaled_ready && listener->ready_event) {
        SetEvent(listener->ready_event);
        signaled_ready = 1;
      }
      break;
    }
    CloseHandle(overlapped.hEvent);

    HANDLE accepted = listener->pending;
    listener->pending = INVALID_HANDLE_VALUE;
    pix_pipe_security security;
    if (!init_pipe_security(&security)) {
      CloseHandle(accepted);
      listener->first_error = ERROR_NOT_ENOUGH_MEMORY;
      break;
    }
    HANDLE next = create_named_pipe_instance(listener->path, FILE_FLAG_OVERLAPPED, &security.attributes);
    DWORD next_error = (next == INVALID_HANDLE_VALUE) ? GetLastError() : 0;
    free_pipe_security(&security);
    if (next == INVALID_HANDLE_VALUE) {
      CloseHandle(accepted);
      listener->first_error = next_error;
      break;
    }
    listener->pending = next;

    uint64_t* payload = (uint64_t*)malloc(sizeof(uint64_t));
    if (payload == NULL) {
      CloseHandle(accepted);
      listener->first_error = ERROR_NOT_ENOUGH_MEMORY;
      break;
    }
    *payload = (uint64_t)(uintptr_t)accepted;
    if (napi_call_threadsafe_function(listener->tsfn, payload, napi_tsfn_blocking) != napi_ok) {
      CloseHandle(accepted);
      free(payload);
      break;
    }
  }
  return 0;
}

static pix_pipe_listener* listener_from_js(napi_env env, napi_value value) {
  uint64_t raw = 0;
  bool lossless = false;
  if (napi_get_value_bigint_uint64(env, value, &raw, &lossless) != napi_ok || !lossless || raw == 0) {
    return NULL;
  }
  pix_pipe_listener* listener = (pix_pipe_listener*)(uintptr_t)raw;
  if (listener->magic != PIX_LISTENER_MAGIC) return NULL;
  return listener;
}

static napi_value listen_protected_named_pipe(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  wchar_t* path = NULL;
  pix_pipe_security security;
  pix_pipe_listener* listener = NULL;
  napi_value resource_name;

  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "path and callback are required");
  }
  path = wide_path_from_js(env, argv[0]);
  if (!path || !is_named_pipe_path(path)) {
    if (path) free(path);
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "path is invalid");
  }
  napi_valuetype callback_type = napi_undefined;
  if (napi_typeof(env, argv[1], &callback_type) != napi_ok || callback_type != napi_function) {
    free(path);
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "callback is required");
  }
  if (!init_pipe_security(&security)) {
    free(path);
    return throw_fixed(env, "NATIVE_INTERNAL", "private security descriptor could not be created");
  }

  listener = (pix_pipe_listener*)calloc(1, sizeof(*listener));
  if (listener == NULL) {
    free_pipe_security(&security);
    free(path);
    return throw_fixed(env, "NATIVE_INTERNAL", "native operation failed");
  }
  listener->magic = PIX_LISTENER_MAGIC;
  listener->path = path;
  listener->pending = create_named_pipe_instance(path, FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED, &security.attributes);
  DWORD error = (listener->pending == INVALID_HANDLE_VALUE) ? GetLastError() : 0;
  free_pipe_security(&security);
  if (listener->pending == INVALID_HANDLE_VALUE) {
    listener->path = NULL;
    destroy_pipe_listener(listener);
    free(path);
    if (error == ERROR_ACCESS_DENIED || error == ERROR_PIPE_BUSY) {
      return throw_fixed(env, "NATIVE_ALREADY_EXISTS", "named pipe already exists");
    }
    return throw_fixed(
      env,
      error == ERROR_INVALID_NAME ? "NATIVE_INVALID_ARGUMENT" : "NATIVE_CREATE_FAILED",
      "named pipe could not be created"
    );
  }

  listener->stop_event = CreateEventW(NULL, TRUE, FALSE, NULL);
  listener->ready_event = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (listener->stop_event == NULL || listener->ready_event == NULL) {
    destroy_pipe_listener(listener);
    return throw_fixed(env, "NATIVE_INTERNAL", "named pipe listener could not be started");
  }
  if (napi_create_string_utf8(env, "pix-named-pipe", NAPI_AUTO_LENGTH, &resource_name) != napi_ok ||
      napi_create_threadsafe_function(
        env,
        argv[1],
        NULL,
        resource_name,
        0,
        1,
        NULL,
        NULL,
        listener,
        listener_js_cb,
        &listener->tsfn
      ) != napi_ok) {
    destroy_pipe_listener(listener);
    return throw_fixed(env, "NATIVE_INTERNAL", "named pipe listener could not be started");
  }
  listener->thread = CreateThread(NULL, 0, pipe_listener_thread, listener, 0, NULL);
  if (listener->thread == NULL) {
    destroy_pipe_listener(listener);
    return throw_fixed(env, "NATIVE_INTERNAL", "named pipe listener could not be started");
  }
  // Bounded readiness handshake: returning from this N-API call means the
  // first accept has been armed, not merely that a pipe instance was created.
  if (WaitForSingleObject(listener->ready_event, 2000) != WAIT_OBJECT_0 || listener->first_error != ERROR_SUCCESS) {
    InterlockedExchange(&listener->stopping, 1);
    SetEvent(listener->stop_event);
    CancelIoEx(listener->pending, NULL);
    WaitForSingleObject(listener->thread, 2000);
    destroy_pipe_listener(listener);
    return throw_fixed(env, "NATIVE_CREATE_FAILED", "named pipe listener could not be started");
  }

  napi_value result;
  if (napi_create_bigint_uint64(env, (uint64_t)(uintptr_t)listener, &result) != napi_ok) {
    InterlockedExchange(&listener->stopping, 1);
    SetEvent(listener->stop_event);
    WaitForSingleObject(listener->thread, 2000);
    destroy_pipe_listener(listener);
    return throw_fixed(env, "NATIVE_INTERNAL", "native operation failed");
  }
  return result;
}

static napi_value inspect_protected_named_pipe_listener(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "handle is required");
  }
  pix_pipe_listener* listener = listener_from_js(env, argv[0]);
  if (!listener || listener->pending == NULL || listener->pending == INVALID_HANDLE_VALUE) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "handle is invalid");
  }
  PSECURITY_DESCRIPTOR descriptor = NULL;
  napi_value result = NULL;
  PSID owner = NULL;
  PACL dacl = NULL;
  DWORD security_result = GetSecurityInfo(
    listener->pending,
    SE_KERNEL_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner,
    NULL,
    &dacl,
    NULL,
    &descriptor
  );
  if (security_result != ERROR_SUCCESS) {
    return throw_fixed(
      env,
      security_result == ERROR_ACCESS_DENIED ? "NATIVE_ACCESS_DENIED" : "NATIVE_INSPECT_FAILED",
      "named pipe security could not be inspected"
    );
  }
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  BOOL dacl_present = FALSE;
  BOOL dacl_defaulted = FALSE;
  PACL descriptor_dacl = NULL;
  if (!GetSecurityDescriptorControl(descriptor, &control, &revision) ||
      !GetSecurityDescriptorDacl(descriptor, &dacl_present, &descriptor_dacl, &dacl_defaulted)) {
    LocalFree(descriptor);
    return throw_fixed(env, "NATIVE_INSPECT_FAILED", "named pipe security could not be inspected");
  }
  if (napi_create_object(env, &result) != napi_ok ||
      set_security_evidence(env, result, owner, descriptor_dacl, dacl_present, control) != napi_ok) {
    LocalFree(descriptor);
    return throw_fixed(env, "NATIVE_INTERNAL", "native operation failed");
  }
  LocalFree(descriptor);
  return result;
}

static napi_value close_protected_named_pipe_listener(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "handle is required");
  }
  pix_pipe_listener* listener = listener_from_js(env, argv[0]);
  if (!listener) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "handle is invalid");
  }
  InterlockedExchange(&listener->stopping, 1);
  if (listener->stop_event && listener->stop_event != INVALID_HANDLE_VALUE) {
    SetEvent(listener->stop_event);
  }
  if (listener->pending && listener->pending != INVALID_HANDLE_VALUE) {
    CancelIoEx(listener->pending, NULL);
  }
  if (listener->thread && listener->thread != INVALID_HANDLE_VALUE) {
    WaitForSingleObject(listener->thread, 5000);
  }
  destroy_pipe_listener(listener);
  napi_value result;
  if (napi_get_boolean(env, 1, &result) != napi_ok) {
    return throw_fixed(env, "NATIVE_INTERNAL", "native operation failed");
  }
  return result;
}

static napi_value protect_named_pipe(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  wchar_t* path = NULL;
  PSID user_sid = NULL;
  PSID system_sid = NULL;
  PACL acl = NULL;

  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "path is required");
  }
  path = wide_path_from_js(env, argv[0]);
  if (!path || !is_named_pipe_path(path)) {
    if (path) free(path);
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "path is invalid");
  }

  user_sid = copy_current_user_sid();
  system_sid = create_local_system_sid();
  if (!user_sid || !system_sid) {
    if (user_sid) free(user_sid);
    if (system_sid) FreeSid(system_sid);
    free(path);
    return throw_fixed(env, "NATIVE_INTERNAL", "current user identity could not be inspected");
  }

  acl = create_private_allowlist_acl(user_sid, system_sid);
  if (acl == NULL) {
    free(user_sid);
    FreeSid(system_sid);
    free(path);
    return throw_fixed(env, "NATIVE_INTERNAL", "private security descriptor could not be created");
  }

  DWORD set_result = SetNamedSecurityInfoW(
    path,
    SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
    user_sid,
    NULL,
    acl,
    NULL
  );
  free_explicit_acl(acl);
  free(user_sid);
  FreeSid(system_sid);
  free(path);
  if (set_result != ERROR_SUCCESS) {
    if (set_result == ERROR_FILE_NOT_FOUND || set_result == ERROR_PATH_NOT_FOUND) {
      return throw_fixed(env, "NATIVE_NOT_FOUND", "named pipe does not exist");
    }
    return throw_fixed(
      env,
      set_result == ERROR_ACCESS_DENIED ? "NATIVE_ACCESS_DENIED" : "NATIVE_CREATE_FAILED",
      "named pipe could not be protected"
    );
  }

  napi_value result;
  if (napi_get_boolean(env, 1, &result) != napi_ok) {
    return throw_fixed(env, "NATIVE_INTERNAL", "native operation failed");
  }
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"currentUserSid", NULL, current_user_sid, NULL, NULL, NULL, napi_default, NULL},
    {"inspectPath", NULL, inspect_path, NULL, NULL, NULL, napi_default, NULL},
    {"createPrivateObject", NULL, create_private_object, NULL, NULL, NULL, napi_default, NULL},
    {"createExclusivePrivateFile", NULL, create_exclusive_private_file, NULL, NULL, NULL, napi_default, NULL},
    {"inspectNamedPipe", NULL, inspect_named_pipe, NULL, NULL, NULL, napi_default, NULL},
    {"createProtectedNamedPipe", NULL, create_protected_named_pipe, NULL, NULL, NULL, napi_default, NULL},
    {"inspectNamedPipeHandle", NULL, inspect_named_pipe_handle, NULL, NULL, NULL, napi_default, NULL},
    {"closeNamedPipeHandle", NULL, close_named_pipe_handle, NULL, NULL, NULL, napi_default, NULL},
    {"readNamedPipeHandle", NULL, read_named_pipe_handle, NULL, NULL, NULL, napi_default, NULL},
    {"writeNamedPipeHandle", NULL, write_named_pipe_handle, NULL, NULL, NULL, napi_default, NULL},
    {"listenProtectedNamedPipe", NULL, listen_protected_named_pipe, NULL, NULL, NULL, napi_default, NULL},
    {"inspectProtectedNamedPipeListener", NULL, inspect_protected_named_pipe_listener, NULL, NULL, NULL, napi_default, NULL},
    {"closeProtectedNamedPipeListener", NULL, close_protected_named_pipe_listener, NULL, NULL, NULL, napi_default, NULL},
    {"protectNamedPipe", NULL, protect_named_pipe, NULL, NULL, NULL, napi_default, NULL},
    {"inspectProcess", NULL, inspect_process, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok) {
    napi_throw_error(env, "NATIVE_INTERNAL", "native operation failed");
    return NULL;
  }
  napi_value version;
  if (napi_create_uint32(env, PIX_NATIVE_API_VERSION, &version) != napi_ok ||
      napi_set_named_property(env, exports, "apiVersion", version) != napi_ok) {
    napi_throw_error(env, "NATIVE_INTERNAL", "native operation failed");
    return NULL;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)

#else

static napi_value init(napi_env env, napi_value exports) {
  (void)exports;
  napi_throw_error(env, "NATIVE_UNSUPPORTED_PLATFORM", "Windows native binding is unavailable");
  return NULL;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)

#endif
