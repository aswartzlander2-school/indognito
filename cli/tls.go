package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// cmdTLS generates a self-signed TLS certificate and points the server config at it, so the
// browser↔server connection is encrypted even without a reverse proxy. Self-signed certificates
// make browsers show a one-time trust warning; for a warning-free certificate, use a real domain
// with a reverse proxy (Caddy/nginx/Cloudflare) or an ACME client.
func cmdTLS(args []string) int {
	fs := flag.NewFlagSet("tls", flag.ContinueOnError)
	selfSigned := fs.Bool("self-signed", false, "generate a self-signed certificate and enable TLS")
	off := fs.Bool("off", false, "disable TLS (serve plain http again)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	in, err := loadInstall()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Could not find an Indognito installation. Run \"gnito start\" first.")
		return 1
	}
	cfg, raw, err := readConfigMap(in.ConfigFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Could not read the server config: %v\n", err)
		return 1
	}

	if *off {
		cfg["tls"] = map[string]string{"mode": "off", "cert": "", "key": ""}
		if err := writeConfigMap(in.ConfigFile, cfg, raw); err != nil {
			fmt.Fprintf(os.Stderr, "Could not update the config: %v\n", err)
			return 1
		}
		fmt.Println("TLS disabled. Run \"gnito restart\" to apply.")
		return 0
	}
	if !*selfSigned {
		fmt.Println("Usage: gnito tls --self-signed   (encrypt the browser↔server connection with a self-signed certificate)")
		fmt.Println("       gnito tls --off           (serve plain http again)")
		return 0
	}

	certPath := filepath.Join(in.DataDir, "tls-cert.pem")
	keyPath := filepath.Join(in.DataDir, "tls-key.pem")
	certPEM, keyPEM, err := genSelfSigned()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Could not generate a certificate: %v\n", err)
		return 1
	}
	if err := os.WriteFile(certPath, certPEM, 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "Could not write the certificate: %v\n", err)
		return 1
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "Could not write the private key: %v\n", err)
		return 1
	}
	cfg["tls"] = map[string]string{"mode": "files", "cert": certPath, "key": keyPath}
	if err := writeConfigMap(in.ConfigFile, cfg, raw); err != nil {
		fmt.Fprintf(os.Stderr, "Could not update the config: %v\n", err)
		return 1
	}
	fmt.Println("Generated a self-signed certificate and enabled HTTPS:")
	fmt.Printf("  certificate: %s\n", certPath)
	fmt.Printf("  private key: %s\n", keyPath)
	fmt.Println("Run \"gnito restart\" to apply. Browsers will show a one-time trust warning for a self-signed")
	fmt.Println("certificate; for a warning-free certificate, front Indognito with a reverse proxy on a real domain.")
	return 0
}

// genSelfSigned returns a PEM certificate + key valid for localhost, this host's name, and its IPs.
func genSelfSigned() (certPEM, keyPEM []byte, err error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, nil, err
	}
	tmpl := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "Indognito", Organization: []string{"Indognito"}},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"localhost"},
		IPAddresses:           []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
	}
	if hn, e := os.Hostname(); e == nil && hn != "" && hn != "localhost" {
		tmpl.DNSNames = append(tmpl.DNSNames, hn)
	}
	if addrs, e := net.InterfaceAddrs(); e == nil {
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && !ipn.IP.IsLoopback() {
				tmpl.IPAddresses = append(tmpl.IPAddresses, ipn.IP)
			}
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &priv.PublicKey, priv)
	if err != nil {
		return nil, nil, err
	}
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return nil, nil, err
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return certPEM, keyPEM, nil
}

// readConfigMap loads config.json into a map, tolerating a UTF-8 BOM (Windows editors add one).
func readConfigMap(path string) (map[string]any, []byte, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	raw := b
	if len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
		b = b[3:]
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, nil, err
	}
	return m, raw, nil
}

func writeConfigMap(path string, m map[string]any, _ []byte) error {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600) // no BOM: Node's JSON parser rejects one
}
