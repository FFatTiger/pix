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
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32

#define PIX_NATIVE_API_VERSION 2
#define PIX_MAX_REPORTED_ACES 32

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

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"currentUserSid", NULL, current_user_sid, NULL, NULL, NULL, napi_default, NULL},
    {"inspectPath", NULL, inspect_path, NULL, NULL, NULL, napi_default, NULL},
    {"createPrivateObject", NULL, create_private_object, NULL, NULL, NULL, napi_default, NULL},
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
