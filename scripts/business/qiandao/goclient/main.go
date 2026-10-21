package main

import (
	"crypto/md5"
	"encoding/binary"
	"encoding/hex"
	"bufio"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	utls "github.com/refraction-networking/utls"
)

const pkcs1B64 = "MIIEowIBAAKCAQEAwUL1vcleBVMadyTHcz9CogdDFt5kUEO/O/w+Sv+HYVe65CMGZQCk6K5uY0RLI0yuZIQLBGOwRc9neIVHwoReftLVAbxFbHNIIJTHzy78dFntApFzo/X6nS25t19h0e3Na7iGp4/yq0Wau0Rcm9FDto454uN8cKSxDxUXY7iItFj2VoH4jaxgrGBeYoJj0jPavWg0PPYFdqRDZ5PNVb591F8FsSivFzjINKT6Xb38+BgCTljc7+7ttjZOuAv5jmsInuWRQXMlGO2v9f813j494y2FZbORGjaxRQMoGYHaYhIJHKvQlrlUSFAijjS+uMiR+v1fD5K7qXUQwUWhM6i8QQIDAQABAoIBAEAwRDx30EGGe4jM723IuhHkxZSn4ruB9NcwjWQNgOKE5+7z7yDG2P7rSICx4x7jThzWem5Hyfk1zNELu2zQ2C3ZSqQb6xb9JxyjLcYTfggLAhxTQQxZG5bu4/sStAOsrwizLg4jUl8ubBj8uKGMHKhajsFb+y3SlXhD8hPN66GyQjFXShUWOobYCOE5KUofkbf1SiPfSwG+LmXxro//entfKfKeAS7+P71DX+QSlDA7lOZkKp3XmiEGy7k0y+uVjn1sfAuAXI4gpTy0ryFX3mScDLiLJkznz44L4Nc/OEk5hn8O4oy1H8qAeCIRY7YaUJzTLPLH3amSFRSHCVqRwVECgYEAy5CR+UVhHFjAAaJqtiEt03cq2h8GMudjy4A18ofj6ioLOrgRZbjojMdWOxRKo+EP8j6N/AWMYqZjzGKtO5oJ1Pmku+Q1BPyqp1x8VOswR4FsfHhgUYEtjFK9Kjsr60lBayxOAbJUClmVotG3f3zuD9oCMriVpZ0F8f4UDIbCvA0CgYEA8wr67gxYTXPJMxEN4Cd+NBDGP30By2uXKxF1QMNo3dfeqX4DcsFPz9gDW56eHpHghV2OEBCkAT1rl5vk679GBXjtODQED6OsvImiioGe1im+SmqpsWta4Jf0yKkd5g8vV7sq1EWOdTqYXH6GzKo0us2WQWFvO4CBb5+XjKKzUAUCgYAS3pzZaXf+A7AQtriDl4HC92nufC+76j0S8RiPGc+jtjACSmu6bTCJVDUHFvNwS32J7AiHUxBXWKspmAAM5VOB/X4quJW9l5pOF0GjMYXxKusegp4TEBFjz4ufbYq9rbW1tI6qk5g8uV8oj54d4DvFFmVbxEaC6pJRg0bifl9wxQKBgDyjLa38uH9Cdx1dkOevEsastLmcV7lH86RUK7vnxR8sP6pr/TJBVsdVbqkKLwsTfD/p8orBjBmfGFvwEjJbO34cCJtwJt88B9nWQQ5rfpSSP57Tc9kHHtpQL0ttHj+K5FXwJaRmYj+PSfoxuzIO+S7uIiHXzGe9DQ4rdCUrZq99AoGBALpFqMuXqlpN3ErGZ8fErYlAxihF1sAD7ybj1KHXzhRSsmOiz57nFP+GELfrLdJ1GiBNNws84GcQLE90D2OinCr6k0F+I8oLs1I/XPfSzZueZ1Sy1gBZM7Y2ioD9SIh4yYLSQPpYO+qwiZIM57AIi+oxqrwk6/urvTrRKP7+om75"

var path = "/c2c-web/v1/stock-order/sp-trade-history"

func sign(msg string) string {
	der, _ := base64.StdEncoding.DecodeString(pkcs1B64)
	block := &pem.Block{Type: "RSA PRIVATE KEY", Bytes: der}
	key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		panic(err)
	}
	h := sha256.Sum256([]byte(msg))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, h[:])
	if err != nil {
		panic(err)
	}
	return base64.StdEncoding.EncodeToString(sig)
}

func main() {
	token := os.Args[1] // "Bearer xxx"
	spId := "1051494004002153369"
	if len(os.Args) > 2 {
		spId = os.Args[2]
	}

	// Android netd DNS 对纯Go解析器不可达，直连已知IP（SNI/Host 保持域名）
	addr := "139.224.220.62:443"
	skipVerify := false
	if len(os.Args) > 3 { // 本地调试: "127.0.0.1:8443 insecure"
		addr = os.Args[3]
		skipVerify = len(os.Args) > 4 && os.Args[4] == "insecure"
	}
	rawConn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		panic(err)
	}
	defer rawConn.Close()

	spec := &utls.ClientHelloSpec{
		TLSVersMin: utls.VersionTLS12,
		TLSVersMax: utls.VersionTLS13,
		CipherSuites: []uint16{
			utls.TLS_CHACHA20_POLY1305_SHA256,
			utls.TLS_AES_128_GCM_SHA256,
			utls.TLS_AES_256_GCM_SHA384,
			utls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
			utls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
			utls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			utls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			utls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			utls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			utls.TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA,
			utls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
			utls.TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA,
			utls.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
			utls.TLS_RSA_WITH_AES_128_GCM_SHA256,
			utls.TLS_RSA_WITH_AES_256_GCM_SHA384,
			utls.TLS_RSA_WITH_AES_128_CBC_SHA,
			utls.TLS_RSA_WITH_AES_256_CBC_SHA,
		},
		CompressionMethods: []byte{0},
		Extensions: []utls.TLSExtension{
			&utls.SNIExtension{ServerName: "api.qiandao.com"},
			&utls.GenericExtension{Id: 0x0017, Data: []byte{}},                   // extended_master_secret
			&utls.GenericExtension{Id: 0xff01, Data: []byte{0}},                 // renegotiation_info
			&utls.SupportedCurvesExtension{Curves: []utls.CurveID{utls.X25519, utls.CurveP256, utls.CurveP384}},
			&utls.SupportedPointsExtension{SupportedPoints: []byte{0}},
			&utls.GenericExtension{Id: 35, Data: []byte{}},                      // session_ticket
			&utls.SignatureAlgorithmsExtension{SupportedSignatureAlgorithms: []utls.SignatureScheme{
				utls.ECDSAWithP256AndSHA256,
				utls.PSSWithSHA256,
				utls.PKCS1WithSHA256,
				utls.ECDSAWithP384AndSHA384,
				utls.PSSWithSHA384,
				utls.PKCS1WithSHA384,
				utls.PSSWithSHA512,
				utls.PKCS1WithSHA512,
				utls.PKCS1WithSHA1,
			}},
			&utls.KeyShareExtension{KeyShares: []utls.KeyShare{{Group: utls.X25519}}},
			&utls.PSKKeyExchangeModesExtension{Modes: []uint8{utls.PskModeDHE}},
			&utls.SupportedVersionsExtension{Versions: []uint16{utls.VersionTLS13, utls.VersionTLS12}},
		},
	}

	conn := utls.UClient(rawConn, &utls.Config{ServerName: "api.qiandao.com", InsecureSkipVerify: skipVerify}, utls.HelloCustom)
	if err := conn.ApplyPreset(spec); err != nil {
		panic(err)
	}
	conn.BuildHandshakeState()
	fmt.Println("JA3(ours):", ja3Of(conn.HandshakeState.Hello.Raw))
	if err := conn.Handshake(); err != nil {
		panic(err)
	}

	ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
	if p := os.Getenv("QD_PATH"); p != "" {
		path = p
	}
	offset := os.Getenv("QD_OFFSET")
	if offset == "" {
		offset = "0"
	}
	body := fmt.Sprintf(`{"spId":"%s","offset":"%s","limit":"20"}`, spId, offset)
	if b := os.Getenv("QD_BODY"); b != "" {
		body = b
	}
	sig := sign(path + "" + "" + ts)

	hdrs := []struct{ k, v string }{
		{"accept-encoding", "gzip"},
		{"x-request-version", "6.65.0"},
		{"x-request-sign-type", "RSA2"},
		{"authorization", token},
		{"x-echo-teen-mode", "false"},
		{"x-request-package-sign-version", "0.0.3"},
		{"x-echo-audit", "false"},
		{"x-request-utm_source", "huawei"},
		{"x-request-id", ""},
		{"x-request-sign", sig},
		{"content-length", strconv.Itoa(len(body))},
		{"x-client-package-id", "1006"},
		{"x-request-package-id", "1006"},
		{"x-device-id", "1b21d6b5a6c9e631"},
		{"user-agent", "Kuril+/6.65.0 (Android 15)"},
		{"x-echo-install-id", "MTA1NjQwOTM5MDA2MTQ4NTI4Ng=="},
		{"cache-control", "max-age=3600"},
		{"x-echo-city-code", ""},
		{"content-type", "application/json"},
		{"downloadchannel", "huawei"},
		{"x-request-sign-version", "v1"},
		{"referer", "https://qiandao.cn"},
		{"x-request-channel", "huawei"},
		{"x-echo-region", "CN"},
		{"accept-language", "zh-Hans-CN"},
		{"host", "api.qiandao.com"},
		{"x-request-device", "android"},
		{"x-request-timestamp", ts},
		{"x-request-version-code", "1250"},
	}
	var req strings.Builder
	req.WriteString("POST " + path + " HTTP/1.1\r\n")
	for _, h := range hdrs {
		req.WriteString(h.k + ": " + h.v + "\r\n")
	}
	req.WriteString("\r\n")
	req.WriteString(body)
	if _, err := conn.Write([]byte(req.String())); err != nil {
		panic(err)
	}
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	br := bufio.NewReader(conn)
	status, _ := br.ReadString('\n')
	fmt.Print(status)
	cl := 0
	chunked := false
	for {
		line, err := br.ReadString('\n')
		ll := strings.ToLower(line)
		if strings.HasPrefix(ll, "content-length:") {
			fmt.Sscanf(strings.TrimSpace(line[15:]), "%d", &cl)
		}
		if strings.Contains(ll, "chunked") {
			chunked = true
		}
		if line == "\r\n" || err != nil {
			break
		}
	}
	if chunked {
		var out strings.Builder
		for {
			szLine, err := br.ReadString('\n')
			if err != nil {
				break
			}
			sz := strings.TrimSpace(strings.Split(szLine, ";")[0])
			n, cerr := strconv.ParseUint(sz, 16, 32)
			if cerr != nil || n == 0 {
				break
			}
			b := make([]byte, n)
			io.ReadFull(br, b)
			out.Write(b)
			br.ReadString('\n')
		}
		fmt.Println(out.String())
	} else {
		buf := make([]byte, cl)
		got := 0
		for got < cl {
			n, err := br.Read(buf[got:])
			got += n
			if err != nil {
				break
			}
		}
		fmt.Println(string(buf[:got]))
	}
}

func ja3Of(raw []byte) string {
	grease := map[uint16]bool{0x0a0a: true, 0x1a1a: true, 0x2a2a: true, 0x3a3a: true, 0x4a4a: true, 0x5a5a: true, 0x6a6a: true, 0x7a7a: true, 0x8a8a: true, 0x9a9a: true, 0xaaaa: true, 0xbaba: true, 0xcaca: true, 0xdada: true, 0xeaea: true, 0xfafa: true}
	if len(raw) > 0 && raw[0] == 0x01 { // 无TLS record头，仅handshake消息
		raw = raw[4:]
		p := 0
		_ = p
	}
	p := 0
	if len(raw) >= 5 && raw[0] == 0x16 {
		p = 9
	}
	version := uint16(raw[p])<<8 | uint16(raw[p+1]); p += 2
	p += 32
	sidLen := int(raw[p]); p += 1 + sidLen
	csLen := int(binary.BigEndian.Uint16(raw[p:])); p += 2
	ciphers := []uint16{}
	for i := 0; i < csLen/2; i++ { ciphers = append(ciphers, binary.BigEndian.Uint16(raw[p+i*2:])) }
	p += csLen
	compLen := int(raw[p]); p += 1 + compLen
	exts := []uint16{}
	var curves, points []uint16
	extTotal := int(binary.BigEndian.Uint16(raw[p:])); p += 2
	end := p + extTotal
	for p+4 <= end {
		et := binary.BigEndian.Uint16(raw[p:]); el := int(binary.BigEndian.Uint16(raw[p+2:])); p += 4
		d := raw[p : p+el]; p += el
		exts = append(exts, et)
		if et == 10 && len(d) >= 2 {
			n := int(binary.BigEndian.Uint16(d))
			for i := 0; i < n && 2+i*2+2 <= len(d); i++ { curves = append(curves, binary.BigEndian.Uint16(d[2+i*2:])) }
		}
		if et == 11 && len(d) >= 1 {
			n := int(d[0])
			for i := 0; i < n && 1+i < len(d); i++ { _ = i; points = append(points, uint16(d[1+i])) }
		}
		if et == 43 && len(d) >= 1 {
			n := int(d[0]); vers := []uint16{}
			for i := 0; i < n && 1+i*2+2 <= len(d); i++ { v := binary.BigEndian.Uint16(d[1+i*2:]); if !grease[v] { vers = append(vers, v) } }
			for _, v := range vers { if v > version { version = v } }
		}
	}
	join := func(xs []uint16) string { s := ""; for _, v := range xs { if grease[v] { continue }; if s != "" { s += "-" }; s += strconv.Itoa(int(v)) }; return s }
	ja3 := strconv.Itoa(int(version)) + "," + join(ciphers) + "," + join(exts) + "," + join(curves) + "," + join(points)
	sum := md5.Sum([]byte(ja3))
	return hex.EncodeToString(sum[:]) + " raw=" + ja3
}
