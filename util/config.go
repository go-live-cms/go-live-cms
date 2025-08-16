package util

import (
	"time"

	"github.com/spf13/viper"
)

type Config struct {
	DBDriver             string        `mapstructure:"DB_DRIVER"`
	DBSource             string        `mapstructure:"DB_SOURCE"`
	ServerAddress        string        `mapstructure:"SERVER_ADDRESS"`
	APIPort              string        `mapstructure:"API_PORT"`
	TokenSymmetricKey    string        `mapstructure:"TOKEN_SYMMETRIC_KEY"`
	AccessTokenDuration  time.Duration `mapstructure:"ACCESS_TOKEN_DURATION"`
	RefreshTokenDuration time.Duration `mapstructure:"REFRESH_TOKEN_DURATION"`
	MaxUploadSize        string        `mapstructure:"MAX_UPLOAD_SIZE"`
	UploadPath           string        `mapstructure:"UPLOAD_PATH"`
	IsTestMode           bool          `mapstructure:"IS_TEST_MODE"`
}

func LoadConfig(path string) (config Config, err error) {
	viper.AddConfigPath(path)
	viper.SetConfigName("app")
	viper.SetConfigType("env")

	viper.AutomaticEnv()

	viper.SetDefault("DB_DRIVER", "postgres")
	viper.SetDefault("DB_SOURCE", "postgresql://root:secret@localhost:5432/golive_cms_test?sslmode=disable")
	viper.SetDefault("SERVER_ADDRESS", "0.0.0.0:8080")
	viper.SetDefault("API_PORT", ":8080")
	viper.SetDefault("TOKEN_SYMMETRIC_KEY", "12345678901234567890123456789012")

	if err = viper.ReadInConfig(); err != nil {

		if _, ok := err.(viper.ConfigFileNotFoundError); ok {

		} else {
			return
		}
	}

	err = viper.Unmarshal(&config)
	if err != nil {
		return
	}

	return
}
