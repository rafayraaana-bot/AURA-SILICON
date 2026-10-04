module top_tb;
  reg a;
  reg b;
  wire y;

  top dut(.a(a), .b(b), .y(y));

  initial begin
    a = 0; b = 0; #1; if (y !== 0) $fatal(1, "AND gate failed for 00");
    a = 0; b = 1; #1; if (y !== 0) $fatal(1, "AND gate failed for 01");
    a = 1; b = 0; #1; if (y !== 0) $fatal(1, "AND gate failed for 10");
    a = 1; b = 1; #1; if (y !== 1) $fatal(1, "AND gate failed for 11");
    $display("AURA_SIM_PASS: AND gate passed 4/4 vectors");
    $finish;
  end
endmodule
