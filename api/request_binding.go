package api

// Request body decoding and validation shared by every JSON write endpoint (#139).
//
// bindJSON replaces gin's ShouldBindJSON so all endpoints behave the same way:
//
//   - Unknown fields are rejected (400), so a typo or a server-owned field
//     (id, user_id, created_at, ...) fails loudly instead of being dropped.
//   - Trailing data after the JSON value is rejected.
//   - A body over the route's size limit (bodyLimitMiddleware) is a 413.
//   - Errors never echo Go internals (struct names, Go types, validator tags).
//     The shape is always {"error": "..."}; validation failures add
//     "fields": {"<json name>": "<message>"} for every failing field.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/gin-gonic/gin/binding"
	"github.com/go-playground/validator/v10"
)

var (
	errEmptyBody      = errors.New("request body is required")
	errTrailingData   = errors.New("request body must contain a single JSON value")
	errBodyTooLarge   = errors.New("request body too large")
	errInvalidJSON    = errors.New("request body is not valid JSON")
	unknownFieldRegex = regexp.MustCompile(`^json: unknown field "(.+)"$`)
)

// slugRe matches a URL slug: lowercase letters (any script) and digits in
// hyphen-separated runs, e.g. "hello-world" or "café-2".
var slugRe = regexp.MustCompile(`^[\p{Ll}\p{Lo}\p{N}]+(?:-[\p{Ll}\p{Lo}\p{N}]+)*$`)

// identifierRe matches machine names used in URLs and theme file lookups
// (post type names, extension ids): lowercase ASCII, digits, '-' and '_',
// starting with a letter or digit. No dots or slashes, so never a path.
var identifierRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

// settingKeyRe matches setting and meta keys: ASCII letters, digits, and
// . _ - : (e.g. "_thumbnail_id", "layout.header", "seo:title").
var settingKeyRe = regexp.MustCompile(`^[A-Za-z0-9._:-]+$`)

func init() {
	v, ok := binding.Validator.Engine().(*validator.Validate)
	if !ok {
		return
	}
	// Report fields by their JSON (or form) name, not the Go struct field.
	v.RegisterTagNameFunc(func(f reflect.StructField) string {
		for _, tag := range []string{"json", "form"} {
			name := strings.SplitN(f.Tag.Get(tag), ",", 2)[0]
			if name == "-" {
				return ""
			}
			if name != "" {
				return name
			}
		}
		return f.Name
	})
	mustRegister(v, "slug", func(fl validator.FieldLevel) bool {
		return slugRe.MatchString(fl.Field().String())
	})
	mustRegister(v, "identifier", func(fl validator.FieldLevel) bool {
		return identifierRe.MatchString(fl.Field().String())
	})
	mustRegister(v, "setting_key", func(fl validator.FieldLevel) bool {
		return settingKeyRe.MatchString(fl.Field().String())
	})
	// max_bytes=N limits a string's UTF-8 byte length (max counts runes).
	// bcrypt only reads 72 bytes, so passwords use it.
	mustRegister(v, "max_bytes", func(fl validator.FieldLevel) bool {
		var limit int
		if _, err := fmt.Sscan(fl.Param(), &limit); err != nil {
			return false
		}
		return len(fl.Field().String()) <= limit
	})
}

func mustRegister(v *validator.Validate, tag string, fn validator.Func) {
	if err := v.RegisterValidation(tag, fn); err != nil {
		panic(fmt.Sprintf("register validation %q: %v", tag, err))
	}
}

// bindJSON strictly decodes the request body into obj and validates it.
// On failure it writes the error response and returns false.
func bindJSON(c *gin.Context, obj any) bool {
	if err := decodeJSONBody(c.Request.Body, obj); err != nil {
		respondBindError(c, err)
		return false
	}
	if err := binding.Validator.ValidateStruct(obj); err != nil {
		respondBindError(c, err)
		return false
	}
	return true
}

// bindOptionalJSON is bindJSON for endpoints whose body may be omitted: an
// empty body leaves obj at its zero value. A body that is present must still
// be valid.
func bindOptionalJSON(c *gin.Context, obj any) bool {
	err := decodeJSONBody(c.Request.Body, obj)
	if errors.Is(err, errEmptyBody) {
		return true
	}
	if err != nil {
		respondBindError(c, err)
		return false
	}
	if err := binding.Validator.ValidateStruct(obj); err != nil {
		respondBindError(c, err)
		return false
	}
	return true
}

// decodeJSONBody decodes exactly one JSON value, rejecting unknown fields.
func decodeJSONBody(body io.Reader, obj any) error {
	if body == nil {
		return errEmptyBody
	}
	dec := json.NewDecoder(body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(obj); err != nil {
		if errors.Is(err, io.EOF) {
			return errEmptyBody
		}
		return err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return err
		}
		return errTrailingData
	}
	return nil
}

// respondBindError writes the response for a bindJSON/ShouldBind error.
func respondBindError(c *gin.Context, err error) {
	var (
		maxErr      *http.MaxBytesError
		syntaxErr   *json.SyntaxError
		typeErr     *json.UnmarshalTypeError
		validateErr validator.ValidationErrors
	)
	switch {
	case errors.As(err, &maxErr) || isBodyTooLarge(err):
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": errBodyTooLarge.Error()})
	case errors.Is(err, errEmptyBody), errors.Is(err, errTrailingData):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	case errors.As(err, &validateErr):
		fields := make(map[string]string, len(validateErr))
		for _, fe := range validateErr {
			name := fieldPath(fe)
			if _, seen := fields[name]; !seen {
				fields[name] = fieldErrorMessage(fe)
			}
		}
		first := validateErr[0]
		c.JSON(http.StatusBadRequest, gin.H{
			"error":  fieldPath(first) + " " + fieldErrorMessage(first),
			"fields": fields,
		})
	case errors.As(err, &typeErr):
		field := typeErr.Field
		if field == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "request body must be a JSON " + jsonKind(typeErr.Type)})
			return
		}
		msg := "must be " + withArticle(jsonKind(typeErr.Type))
		c.JSON(http.StatusBadRequest, gin.H{
			"error":  field + " " + msg,
			"fields": map[string]string{field: msg},
		})
	case unknownFieldRegex.MatchString(err.Error()):
		field := unknownFieldRegex.FindStringSubmatch(err.Error())[1]
		c.JSON(http.StatusBadRequest, gin.H{
			"error":  fmt.Sprintf("unknown field %q", field),
			"fields": map[string]string{field: "is not a recognized field"},
		})
	case errors.As(err, &syntaxErr), errors.Is(err, io.ErrUnexpectedEOF):
		c.JSON(http.StatusBadRequest, gin.H{"error": errInvalidJSON.Error()})
	default:
		// Form binding (multipart) and anything unexpected: don't echo it.
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
	}
}

// fieldPath is the failing field's JSON path without the top-level struct
// name, e.g. "title" or "author_ids[2]".
func fieldPath(fe validator.FieldError) string {
	ns := fe.Namespace()
	if i := strings.IndexByte(ns, '.'); i >= 0 {
		return ns[i+1:]
	}
	return fe.Field()
}

// fieldErrorMessage turns a validator failure into a short phrase that
// follows the field name ("title must be at most 255 characters").
func fieldErrorMessage(fe validator.FieldError) string {
	isString := fe.Kind() == reflect.String
	switch fe.Tag() {
	case "required":
		return "is required"
	case "min":
		if isString {
			return "must be at least " + fe.Param() + " characters"
		}
		if fe.Kind() == reflect.Slice || fe.Kind() == reflect.Map {
			return "must have at least " + fe.Param() + " items"
		}
		return "must be at least " + fe.Param()
	case "max":
		if isString {
			return "must be at most " + fe.Param() + " characters"
		}
		if fe.Kind() == reflect.Slice || fe.Kind() == reflect.Map {
			return "must have at most " + fe.Param() + " items"
		}
		return "must be at most " + fe.Param()
	case "max_bytes":
		return "must be at most " + fe.Param() + " bytes"
	case "gt":
		return "must be greater than " + fe.Param()
	case "oneof":
		return "must be one of: " + strings.ReplaceAll(fe.Param(), " ", ", ")
	case "email":
		return "must be a valid email address"
	case "http_url":
		return "must be an http or https URL"
	case "alphanum":
		return "must contain only letters and digits"
	case "slug":
		return "must be lowercase letters and digits separated by single hyphens"
	case "identifier":
		return "must be lowercase letters, digits, '-' or '_'"
	case "setting_key":
		return "must contain only letters, digits, '.', '_', '-' or ':'"
	case "uuid", "uuid4":
		return "must be a UUID"
	default:
		return "is invalid"
	}
}

// jsonKind names the JSON type a Go type decodes from.
func jsonKind(t reflect.Type) string {
	if t == nil {
		return "value"
	}
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	switch t.Kind() {
	case reflect.String:
		return "string"
	case reflect.Bool:
		return "boolean"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return "integer"
	case reflect.Float32, reflect.Float64:
		return "number"
	case reflect.Slice, reflect.Array:
		return "array"
	case reflect.Map, reflect.Struct:
		return "object"
	default:
		return "value"
	}
}

func withArticle(kind string) string {
	switch kind {
	case "integer", "array", "object":
		return "an " + kind
	default:
		return "a " + kind
	}
}
