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
  char* utf8 = NULL;
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
  napi_valuetype value_type = napi_undefined;
  if (napi_typeof(env, argv[0], &value_type) != napi_ok || value_type != napi_string) {
    return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "path is invalid");
  }
  size_t utf8_length = 0;
  utf8 = utf8_copy(env, argv[0], &utf8_length);
  if (!utf8) return throw_fixed(env, "NATIVE_INVALID_ARGUMENT", "path is invalid");
  path = utf8_to_wide(utf8, utf8_length);
  free(utf8);
  utf8 = NULL;
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
      set_bool(env, result, "daclProtected", (control & SE_DACL_PROTECTED) != 0) != napi_ok) {
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

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"currentUserSid", NULL, current_user_sid, NULL, NULL, NULL, napi_default, NULL},
    {"inspectPath", NULL, inspect_path, NULL, NULL, NULL, napi_default, NULL},
  };
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok) {
    napi_throw_error(env, "NATIVE_INTERNAL", "native operation failed");
    return NULL;
  }
  napi_value version;
  if (napi_create_uint32(env, 1, &version) != napi_ok ||
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
